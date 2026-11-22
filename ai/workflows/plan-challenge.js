export const meta = { name: 'plan-challenge', description: 'Runs the selected adversarial plan challenges and returns their parsed verdicts.', phases: [{ title: 'Challenge', detail: 'Challenge simplicity, and scale when selected, concurrently.' }] }

const allLaneBriefs = [
  {
    lane: 'simplify',
    brief: 'Per step: CUT when the goal still lands without it (YAGNI, gold-plating, unenforceable docs, tests duplicating coverage, a guarantee the goal never states such as fresh reads, exactly-once, ordering, or concurrent writers); SHRINK to existing code, a standard tool, fewer files, or a merge with a step it duplicates; otherwise KEEP. Every verdict, KEEP included, carries the same burden: cite the file:line or command that settles it.'
  },
  {
    lane: 'scale',
    brief: 'For each step name the input that grows when the feature meets real data (rows, files, carbon units, requests) and the time and space bound of the approach the step describes. Argue SHRINK when a lower-order approach exists using existing code, a flat array indexed by a dense id or a keyed lookup when keys are sparse, a single pass, or an index or page bound already present in the repo and verified there before the SHRINK is claimed, so the step is rewritten to it at the same plan size. Press the data layout of every step on a hot path: can a hash table become a flat array, can a pointer become an index into that array, can the most-read fields pack into the upper bits of the index, should an array of structures become a structure of arrays. A step that adds a cache or memo of computed results to make a path faster is a SHRINK to the redesign that makes the path fast without it, at the same or a lower bound, naming the cache it removes; an index built to join or look up by key is not a cache, and neither is a store kept for correctness or an external rate limit. KEEP when the bound is already linear or is inherent to the operation, and say which. Open `because` with `bound: O(...) in <input>` so the bound is machine-findable.'
  }
]

function numberedStepsFrom(planText) {
  const stepNumbers = new Set()
  for (const planLine of String(planText == null ? '' : planText).split('\n')) {
    if (/^(?:\t| {2})/.test(planLine)) {
      continue
    }
    const markerlessLine = planLine.replace(/^[-*#>\s]+/, '')
    const stepMatch = markerlessLine.match(/^(?:step\s+(\d+)\s*[-.):]|(\d+)[.):])\s+\S/i)
    if (!stepMatch) {
      continue
    }
    stepNumbers.add(Number(stepMatch[1] || stepMatch[2]))
  }
  return [...stepNumbers]
}

function buildChallengePrompt(laneBrief) {
  return `Scope: judging the supplied plan text against the repo at ${args.repoPath}, read-only
Out of scope: editing anything, proposing new steps, re-planning the work
Definition of done: a STEP_VERDICTS block covering every numbered step

Goal:
${args.goal}

Plan text, verbatim:
${args.planText}

Repo path: ${args.repoPath}
Lane: ${laneBrief.lane}
Lane brief, verbatim:
${laneBrief.brief}

Verify claims against the repo with Read, Grep, Glob, or read-only commands before asserting them. A verdict resting on nothing gets evidence: unverified and is worth less at convergence.

STEP_VERDICTS:
- step: <n> | verdict: <CUT|SHRINK|KEEP> | because: <one sentence> | evidence: <file:line, command output, or unverified>
- step: ...

PLAN_SUMMARY:
<one paragraph: the plan's weakest step and the single biggest simplification available>

Cover every numbered step exactly once and in step order. Use one verdict per line and no bare | inside a field. End with this block and nothing after it.`
}

function verdictsFrom(laneText) {
  if (typeof laneText !== 'string') {
    return null
  }
  const blockMatch = laneText.match(/STEP_VERDICTS:[ \t]*\n([\s\S]*?)(?:\nPLAN_SUMMARY:|$)/)
  if (!blockMatch) {
    return null
  }
  const planSummaryMatch = laneText.match(/PLAN_SUMMARY:[ \t]*([\s\S]*)$/)
  if (!planSummaryMatch || planSummaryMatch[1].trim() === '') {
    return null
  }
  const verdicts = []
  for (const blockLine of blockMatch[1].split('\n')) {
    const verdictMatch = blockLine.trim().match(/^- step: (\d+) \| verdict: (CUT|SHRINK|KEEP) \| because: (.+) \| evidence: (.+)$/)
    if (verdictMatch) {
      verdicts.push({ step: Number(verdictMatch[1]), verdict: verdictMatch[2], because: verdictMatch[3], evidence: verdictMatch[4] })
    }
  }
  return verdicts
}

function verdictStepNumbersFrom(laneText) {
  return verdictsFrom(laneText)?.map((verdict) => verdict.step) ?? null
}

function coversEveryPlanStep(laneText, requiredStepNumbers) {
  const stepNumbers = verdictStepNumbersFrom(laneText)
  if (!stepNumbers) {
    return false
  }
  const distinctStepNumbers = new Set(stepNumbers)
  if (distinctStepNumbers.size !== stepNumbers.length) {
    return false
  }
  if (requiredStepNumbers.length === 0) {
    return false
  }
  return requiredStepNumbers.every((stepNumber) => distinctStepNumbers.has(stepNumber))
}

function describeCoverageFailure(laneText, requiredStepNumbers) {
  const stepNumbers = verdictStepNumbersFrom(laneText)
  if (!stepNumbers) {
    return 'no STEP_VERDICTS block followed by a non-empty PLAN_SUMMARY'
  }
  const uncoveredStepNumbers = requiredStepNumbers.filter((stepNumber) => !stepNumbers.includes(stepNumber))
  if (uncoveredStepNumbers.length === 0) {
    return 'a step covered more than once'
  }
  return `no verdict for step ${uncoveredStepNumbers.join(', ')}`
}

function runChallengeLane(laneBrief, retryPreamble = '') {
  const challengePrompt = `${retryPreamble}${buildChallengePrompt(laneBrief)}`
  return agent(challengePrompt, { model: 'opus', label: `${laneBrief.lane} challenge`, phase: 'Challenge', agentType: 'plan-challenger' })
}

function rerunChallengeLane(laneBrief, firstLaneText, requiredStepNumbers) {
  const resumeSafeRetryId = args.retryAttemptId ?? 'lane rerun'
  const retryPreamble = `Retry attempt id: ${resumeSafeRetryId}\n\nValidation failure reason: ${describeCoverageFailure(firstLaneText, requiredStepNumbers)}\n\n`
  return runChallengeLane(laneBrief, retryPreamble)
}

phase('Challenge')
const laneBriefs = allLaneBriefs.filter((laneBrief) => laneBrief.lane === 'simplify' || (args.lanes ?? []).includes(laneBrief.lane))
const requiredStepNumbers = numberedStepsFrom(args.planText)
if (requiredStepNumbers.length === 0) {
  return { lanes: [], survivingLanes: [] }
}

const firstLaneTexts = await parallel(laneBriefs.map((laneBrief) => () => runChallengeLane(laneBrief)))
const laneTextsByName = new Map(laneBriefs.map((laneBrief, laneIndex) => [laneBrief.lane, firstLaneTexts[laneIndex]]))
const lanesNeedingRerun = laneBriefs.filter((laneBrief) => !coversEveryPlanStep(laneTextsByName.get(laneBrief.lane), requiredStepNumbers))

if (lanesNeedingRerun.length > 0) {
  const rerunLaneTexts = await parallel(lanesNeedingRerun.map((laneBrief) => () => rerunChallengeLane(laneBrief, laneTextsByName.get(laneBrief.lane), requiredStepNumbers)))
  for (let laneIndex = 0; laneIndex < lanesNeedingRerun.length; laneIndex += 1) {
    laneTextsByName.set(lanesNeedingRerun[laneIndex].lane, rerunLaneTexts[laneIndex])
  }
}

const lanes = laneBriefs.map((laneBrief) => laneTextsByName.get(laneBrief.lane)).flatMap((laneText, laneIndex) => coversEveryPlanStep(laneText, requiredStepNumbers) ? [{ lane: laneBriefs[laneIndex].lane, verdicts: verdictsFrom(laneText) }] : [])
const survivingLanes = lanes.map((laneOutput) => laneOutput.lane)
return { lanes, survivingLanes }
