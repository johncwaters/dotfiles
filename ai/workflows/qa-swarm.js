export const meta = { name: 'qa-swarm', description: 'Routes a pinned review through the required lanes and converges their findings.', phases: [{ title: 'Route', detail: 'Rate the touched surface and select lanes.' }, { title: 'Review', detail: 'Run the selected review lanes concurrently.' }, { title: 'Converge', detail: 'Normalize and converge the lane findings.' }] }

const codexExecCommandPrefix = 'codex exec --dangerously-bypass-approvals-and-sandbox -m'
const grokTiebreakCommand = 'grok --prompt-file <file> --always-approve'

const laneDefinitions = [
  {
    name: 'code',
    recommendable: false,
    blocking: true,
    classNeedles: [],
    trigger: '',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Code review', phase: 'Review', agentType: 'code-reviewer' })
  },
  {
    name: 'security',
    recommendable: true,
    blocking: true,
    classNeedles: ['security'],
    trigger: 'the diff touches auth, input handling, crypto, payments, PII, secrets, infrastructure, or destructive operations',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'fable', label: 'Security review', phase: 'Review', agentType: 'security-reviewer' })
  },
  {
    name: 'structure',
    recommendable: true,
    blocking: true,
    classNeedles: ['structural', 'structure'],
    trigger: 'the diff is a refactor, establishes a new module or boundary, or moves responsibilities across existing ones',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Structure review', phase: 'Review', agentType: 'structure-reviewer' })
  },
  {
    name: 'necessity',
    recommendable: true,
    blocking: true,
    classNeedles: [],
    trigger: 'the diff introduces a net-new file, exported symbol, or doc section, and the context states a goal',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Necessity review', phase: 'Review', agentType: 'necessity-reviewer' })
  },
  {
    name: 'scale',
    recommendable: true,
    blocking: true,
    classNeedles: ['scale'],
    trigger: 'the diff adds or changes a loop, recursion, query, batch, cache, or list endpoint whose input the context does not bound by fact',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Scale review', phase: 'Review', agentType: 'scale-reviewer' })
  },
  {
    name: 'external',
    recommendable: false,
    blocking: false,
    classNeedles: [],
    trigger: '',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'External review', phase: 'Review' })
  }
]

const laneDefinitionsByName = new Map(laneDefinitions.map((laneDefinition) => [laneDefinition.name, laneDefinition]))
const selectableLaneNames = laneDefinitions.map((laneDefinition) => laneDefinition.name)
const recommendableLaneDefinitions = laneDefinitions.filter((laneDefinition) => laneDefinition.recommendable)
const recommendableLaneNames = recommendableLaneDefinitions.map((laneDefinition) => laneDefinition.name)
const blockingLaneNames = new Set(laneDefinitions.filter((laneDefinition) => laneDefinition.blocking).map((laneDefinition) => laneDefinition.name))
const laneTriggerTable = ['| Lane | Triggers when |', '|---|---|', ...recommendableLaneDefinitions.map((laneDefinition) => `| ${laneDefinition.name} | ${laneDefinition.trigger} |`)].join('\n')

const routerSchema = {
  type: 'object',
  properties: {
    danger: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    complexity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    dangerFact: { type: 'string' },
    fileClasses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, class: { type: 'string' } },
        required: ['file', 'class']
      }
    },
    lanes: { type: 'array', items: { type: 'string', enum: recommendableLaneNames } },
    laneJustifications: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    route: { type: 'string' }
  },
  required: ['danger', 'complexity', 'dangerFact', 'fileClasses', 'lanes', 'laneJustifications', 'findings', 'route']
}

const severityRankByName = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const mergeTagPrefixes = ['convergent: ', 'contested: ']
const reviewerTagPattern = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?$/i
const maxFindingsPerLane = 10

function formatLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '(none)'
  }
  return lines.join('\n')
}

function formatRoundState(round) {
  if (!round) {
    return 'Round state: none.'
  }
  return `Round number: ${round.number}\nRound touched files: ${formatLines(round.touchedFiles)}\nReporting bar: ${round.reportingBar}\nFocus on the round touched files and on the regression and declined checks. Keep the full REVIEW_CMD sweep; only what is worth reporting on settled ground changes.`
}

function normalizeFilePath(filePath) {
  const trimmedPath = String(filePath == null ? '' : filePath).trim()
  const repoPathPrefix = args.repoPath ? `${String(args.repoPath).replace(/\/+$/, '')}/` : ''
  if (repoPathPrefix && trimmedPath.startsWith(repoPathPrefix)) {
    return trimmedPath.slice(repoPathPrefix.length).replace(/^(\.\/)+/, '')
  }
  return trimmedPath.replace(/^(\.\/)+/, '')
}

function laneNamesRecommendedBy(routerResult) {
  const recommendedLaneNames = new Set()
  for (const recommendation of routerResult.lanes || []) {
    const normalizedRecommendation = String(recommendation).toLowerCase().trim()
    if (selectableLaneNames.includes(normalizedRecommendation)) {
      recommendedLaneNames.add(normalizedRecommendation)
    }
  }
  return recommendedLaneNames
}

function withoutMergeTagPrefixes(taggedValue) {
  let remainingValue = taggedValue.trim()
  let strippedAPrefix = true
  while (strippedAPrefix) {
    strippedAPrefix = false
    for (const mergeTagPrefix of mergeTagPrefixes) {
      if (remainingValue.startsWith(mergeTagPrefix)) {
        remainingValue = remainingValue.slice(mergeTagPrefix.length).trim()
        strippedAPrefix = true
      }
    }
  }
  return remainingValue
}

function reviewerTagsFrom(reviewerValue) {
  const composedValue = String(reviewerValue == null ? '' : reviewerValue).trim()
  return composedValue.split(/ \+ | vs /).map(withoutMergeTagPrefixes).filter((reviewerTag) => reviewerTag !== '')
}

function laneOwnersFromFindings(findingLines) {
  const laneOwners = new Set()
  for (const findingLine of findingLines || []) {
    const reviewerMatch = findingLine.match(/(?:^| \| )reviewer: ([^|]+)/)
    if (!reviewerMatch) {
      continue
    }
    for (const reviewerTag of reviewerTagsFrom(reviewerMatch[1])) {
      const laneName = reviewerTag.split('/')[0]
      if (selectableLaneNames.includes(laneName)) {
        laneOwners.add(laneName)
      }
    }
  }
  return laneOwners
}

function filesClassifiedForLane(routerResult, laneName) {
  if (!routerResult) {
    return []
  }
  const laneDefinition = laneDefinitionsByName.get(laneName)
  if (!laneDefinition) {
    return []
  }
  const fileClasses = routerResult.fileClasses || []
  if (laneDefinition.classNeedles.length === 0) {
    return fileClasses
  }
  return fileClasses.filter((fileClass) => laneDefinition.classNeedles.some((classNeedle) => String(fileClass.class).toLowerCase().includes(classNeedle)))
}

function findingsHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*STRUCTURED_FINDINGS:[ \t]*$/gm)]
}

function summaryHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*OVERALL_SUMMARY:[ \t]*(.*)$/gm)]
}

function withLastBareHeaderColonized(text, headerName, colonizedHeaderMatchesIn) {
  if (colonizedHeaderMatchesIn(text).length > 0) {
    return text
  }
  const bareHeaderLines = new RegExp(`^[ \\t#>*-]*${headerName}[ \\t]*$`, 'gm')
  let lastBareHeaderMatch = null
  for (const bareHeaderMatch of text.matchAll(bareHeaderLines)) {
    lastBareHeaderMatch = bareHeaderMatch
  }
  if (!lastBareHeaderMatch) {
    return text
  }
  return `${text.slice(0, lastBareHeaderMatch.index)}${headerName}:${text.slice(lastBareHeaderMatch.index + lastBareHeaderMatch[0].length)}`
}

function withHeaderColons(text) {
  const withoutWrappers = text
    .replace(/^[ \t]*```[a-z]*[ \t]*$\n?/gm, '')
    .replace(/^[ \t]*END_STRUCTURED_FINDINGS:?[ \t]*\n?/gm, '')
  const withFindingsHeader = withLastBareHeaderColonized(withoutWrappers, 'STRUCTURED_FINDINGS', findingsHeaderMatchesIn)
  const withBothHeaders = withLastBareHeaderColonized(withFindingsHeader, 'OVERALL_SUMMARY', summaryHeaderMatchesIn)
  return withBothHeaders.replace(/^[ \t]*(?:\((?:no findings|nothing|empty|none found)\)|\[\]|none)[ \t]*$/gmi, '(none)')
}

function blockAndSummaryFrom(normalizedText) {
  const findingsHeaders = findingsHeaderMatchesIn(normalizedText)
  const summaryHeaders = summaryHeaderMatchesIn(normalizedText)
  if (findingsHeaders.length !== 1 || summaryHeaders.length !== 1) {
    return null
  }
  const findingsHeader = findingsHeaders[0]
  const summaryHeader = summaryHeaders[0]
  if (summaryHeader.index < findingsHeader.index) {
    return null
  }
  return {
    blockText: normalizedText.slice(findingsHeader.index + findingsHeader[0].length, summaryHeader.index).trim(),
    summaryText: `${summaryHeader[1]}${normalizedText.slice(summaryHeader.index + summaryHeader[0].length)}`.trim(),
  }
}

function lineFieldIsValid(lineValue) {
  if (lineValue.trim().toLowerCase() === 'general') {
    return true
  }
  return /^[0-9]+$/.test(lineValue.trim()) && Number(lineValue.trim()) > 0
}

function reviewerFieldIsValid(reviewerValue) {
  const reviewerTags = reviewerTagsFrom(reviewerValue)
  if (reviewerTags.length === 0) {
    return false
  }
  return reviewerTags.every((reviewerTag) => reviewerTagPattern.test(reviewerTag))
}

function parseFindingLine(findingLine) {
  const normalizedLine = findingLine.trim().replace(/^- /, '')
  if (!normalizedLine.startsWith('file: ')) {
    return null
  }
  const bodySeparator = ' | body: '
  const bodySeparatorIndex = normalizedLine.indexOf(bodySeparator)
  if (bodySeparatorIndex < 0) {
    return null
  }
  const fields = { body: normalizedLine.slice(bodySeparatorIndex + bodySeparator.length).trim() }
  if (fields.body === '') {
    return null
  }
  for (const fieldText of normalizedLine.slice(0, bodySeparatorIndex).split(' | ')) {
    const separatorIndex = fieldText.indexOf(': ')
    if (separatorIndex < 1) {
      return null
    }
    fields[fieldText.slice(0, separatorIndex)] = fieldText.slice(separatorIndex + 2).trim()
  }
  if (!fields.file || !fields.line || !fields.severity || !fields.reviewer) {
    return null
  }
  if (!lineFieldIsValid(fields.line) || !reviewerFieldIsValid(fields.reviewer)) {
    return null
  }
  const normalizedSeverity = fields.severity.trim().toUpperCase()
  if (severityRankByName[normalizedSeverity] === undefined) {
    return null
  }
  fields.severity = normalizedSeverity
  fields.file = normalizeFilePath(fields.file)
  const anchorsWholeFile = fields.line.trim().toLowerCase() === 'general'
  if (anchorsWholeFile) {
    fields.line = 'general'
    delete fields.side
  }
  if (!anchorsWholeFile) {
    const declaredSide = (fields.side || 'RIGHT').trim().toUpperCase()
    if (declaredSide !== 'RIGHT' && declaredSide !== 'LEFT') {
      return null
    }
    fields.side = declaredSide
  }
  const rawFieldTexts = [`file: ${fields.file}`, `line: ${fields.line}`]
  if (fields.side) {
    rawFieldTexts.push(`side: ${fields.side}`)
  }
  rawFieldTexts.push(`severity: ${fields.severity}`, `reviewer: ${fields.reviewer}`, `body: ${fields.body}`)
  return { raw: `- ${rawFieldTexts.join(' | ')}`, fields }
}

function severityRankOf(parsedFinding) {
  return severityRankByName[parsedFinding.fields.severity]
}

function parseLaneResponse(rawLaneText) {
  const deadResponse = { hasParseableBlock: false, hasUnparseableRow: false, findings: [], summary: '', hitFindingCap: false }
  if (typeof rawLaneText !== 'string' || rawLaneText.trim() === '') {
    return deadResponse
  }
  const laneText = withHeaderColons(rawLaneText)
  const splitResponse = blockAndSummaryFrom(laneText)
  if (!splitResponse) {
    return deadResponse
  }
  const summary = splitResponse.summaryText
  if (summary === '') {
    return deadResponse
  }
  const blockText = splitResponse.blockText
  if (blockText === '(none)') {
    return { hasParseableBlock: true, hasUnparseableRow: false, findings: [], summary, hitFindingCap: false }
  }
  const parsedRows = blockText.split('\n').map((blockLine) => blockLine.trim()).filter((blockLine) => blockLine !== '').map(parseFindingLine)
  const hasUnparseableRow = parsedRows.some((parsedRow) => !parsedRow)
  const rankedFindings = parsedRows.filter(Boolean).sort((leftFinding, rightFinding) => severityRankOf(leftFinding) - severityRankOf(rightFinding))
  const keptFindings = rankedFindings.slice(0, maxFindingsPerLane)
  return { hasParseableBlock: keptFindings.length > 0, hasUnparseableRow, findings: keptFindings, summary, hitFindingCap: rankedFindings.length > keptFindings.length }
}

function truncatedLaneTagsFrom(summaryText) {
  const truncatedMatch = summaryText.match(/truncated lanes:[ \t]*([^.\n]*)/i)
  if (!truncatedMatch) {
    return null
  }
  const declaredTagText = truncatedMatch[1].trim()
  if (declaredTagText.toLowerCase() === 'none') {
    return new Set()
  }
  return new Set(declaredTagText.split(',').map((laneTag) => laneTag.trim().toLowerCase()).filter((laneTag) => laneTag !== ''))
}

function isConvergedBlock(rawJudgmentText, cappedLaneNames, changedFileNames) {
  if (typeof rawJudgmentText !== 'string') {
    return false
  }
  const parsedJudgment = parseLaneResponse(rawJudgmentText)
  if (!parsedJudgment.hasParseableBlock || parsedJudgment.hasUnparseableRow) {
    return false
  }
  if (parsedJudgment.findings.some((parsedFinding) => !changedFileNames.has(parsedFinding.fields.file))) {
    return false
  }
  const declaredTruncatedLaneTags = truncatedLaneTagsFrom(parsedJudgment.summary)
  if (!declaredTruncatedLaneTags) {
    return false
  }
  return cappedLaneNames.every((cappedLaneName) => declaredTruncatedLaneTags.has(cappedLaneName.toLowerCase()))
}

function buildRouterAssessmentPrompt(filesToClassify, routeInstruction, routeOutcomeInstruction = '') {
  return `Scope: classify and review ${formatLines(filesToClassify)} under ${args.reviewCmd}
Out of scope: pre-existing issues outside that changed-file set; unchanged lines may be read but never anchored
Definition of done: return the validated router object described below

${routeInstruction}
Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${args.reviewCmd}
Caller context, verbatim:
${args.context}
Files to classify:
${formatLines(filesToClassify)}

Rate danger and complexity LOW, MEDIUM, or HIGH. Give the one-sentence fact that set danger. Classify each supplied file into one or more of logic, security surface, structural, scale surface, config, test, or docs. Scale surface means iteration, recursion, queries, or accumulation over a collection whose size the context does not bound. Recommend every lane whose trigger this diff meets, from this table and no other source:

${laneTriggerTable}

The code lane always runs and the external lane follows from your ratings, so neither is recommendable here. Put bare lane names in lanes, and one justification clause per recommended lane, in the same order, in laneJustifications. Return any real findings as complete STRUCTURED_FINDINGS lines tagged router, anchored to the changed set. ${routeOutcomeInstruction}Return JSON matching this schema:
${JSON.stringify(routerSchema)}`
}

async function routeReviewOnOpus(filesToClassify, fallbackReason) {
  const fallbackRouteInstruction = `Act as the router because the external route reported ${fallbackReason}. Read the repo and run the exact REVIEW_CMD. Do not spawn or dispatch anything.`
  const fallbackRoute = args.claudeOnly ? 'opus-claude-only' : 'opus'
  const fallbackPrompt = buildRouterAssessmentPrompt(filesToClassify, fallbackRouteInstruction, `Set route to ${fallbackRoute}. `)
  const fallbackRouter = await agent(fallbackPrompt, { model: 'opus', label: 'Route review fallback', phase: 'Route', schema: routerSchema })
  if (!fallbackRouter) {
    return null
  }
  return { ...fallbackRouter, route: fallbackRoute }
}

async function routeReview(filesToClassify) {
  phase('Route')
  if (args.claudeOnly) {
    return { routerResult: await routeReviewOnOpus(filesToClassify, 'Claude-only session routing'), degradationNote: '' }
  }
  const dispatchRouteInstruction = `You are a dispatcher only. Do not answer the router questions yourself. Write the dispatched router prompt below to a temp file and run ${codexExecCommandPrefix} gpt-5.6-terra < <promptfile>. On a rate-limit or usage-cap error, run it once with gpt-5.6-luna. On a model or CLI error, or a second quota error, return the required placeholder object with route OPUS_REQUIRED. The placeholder uses LOW for both ratings, the error as dangerFact, empty arrays, and no guessed review answer. On success, return the Codex JSON verbatim, with route set to the model that answered.\n\nDispatched router prompt:`
  const dispatchPrompt = buildRouterAssessmentPrompt(filesToClassify, dispatchRouteInstruction)
  const dispatchedRouter = await agent(dispatchPrompt, { model: 'sonnet', label: 'Route review', phase: 'Route', schema: routerSchema })
  if (dispatchedRouter && dispatchedRouter.route !== 'OPUS_REQUIRED') {
    return { routerResult: dispatchedRouter, degradationNote: '' }
  }
  const dispatchFailureDetail = dispatchedRouter ? String(dispatchedRouter.dangerFact || '').trim() : 'router agent death'
  const routeFailureReason = dispatchFailureDetail === '' ? 'OPUS_REQUIRED with no reported detail' : dispatchFailureDetail
  const fallbackRouterResult = await routeReviewOnOpus(filesToClassify, routeFailureReason)
  return { routerResult: fallbackRouterResult, degradationNote: `external router failed with ${routeFailureReason}, so opus routed instead and the routing row for this run is stale` }
}

function securityIsForcedBy(routerResult) {
  if (routerResult.danger === 'HIGH') {
    return true
  }
  return filesClassifiedForLane(routerResult, 'security').length > 0
}

function laneOwnersCarriedIntoThisRound() {
  return laneOwnersFromFindings([...(args.claimedFixed || []), ...(args.declined || [])])
}

function selectLaneNames(routerResult) {
  if (!routerResult) {
    const noRouterLaneNames = new Set(['code', 'security'])
    for (const carriedLaneName of laneOwnersCarriedIntoThisRound()) {
      noRouterLaneNames.add(carriedLaneName)
    }
    return { laneNames: [...noRouterLaneNames], reason: 'the router was unavailable, so the no-router default applies, unioned with the carried claimed-fixed and declined lane owners' }
  }
  const recommendedLaneNames = laneNamesRecommendedBy(routerResult)
  const laneNames = new Set(['code'])
  if (securityIsForcedBy(routerResult)) {
    laneNames.add('security')
  }
  if (routerResult.danger === 'HIGH' || routerResult.complexity === 'HIGH') {
    laneNames.add('external')
  }
  if (!args.round || args.round.number < 2) {
    for (const laneName of recommendableLaneNames) {
      if (recommendedLaneNames.has(laneName)) {
        laneNames.add(laneName)
      }
    }
    return { laneNames: [...laneNames], reason: 'round one uses the router triggers, forces security on a security-surface file or HIGH danger, and adds external for a HIGH danger or complexity rating' }
  }
  const carriedLaneOwners = laneOwnersCarriedIntoThisRound()
  for (const laneName of recommendableLaneNames) {
    if (recommendedLaneNames.has(laneName) || carriedLaneOwners.has(laneName)) {
      laneNames.add(laneName)
    }
  }
  if (carriedLaneOwners.has('external')) {
    laneNames.add('external')
  }
  return { laneNames: [...laneNames], reason: 'later rounds use touched-file router triggers, carried claimed-fixed or declined owners including external, the forced security trigger, and the touched set HIGH trigger for external' }
}

function buildLanePrompt(laneName, routerResult, laneNames) {
  const routerRatings = routerResult ? `danger ${routerResult.danger}; complexity ${routerResult.complexity}; danger fact ${routerResult.dangerFact}; route ${routerResult.route}` : 'router unavailable'
  const classifiedFiles = routerResult ? JSON.stringify(filesClassifiedForLane(routerResult, laneName)) : '(router unavailable)'
  const lanePrompt = `Scope: changed files ${formatLines(args.changedFiles)} under ${args.reviewCmd}
Out of scope: pre-existing issues outside that set; unchanged lines inside it are read, never anchored
Definition of done: this lane's STRUCTURED_FINDINGS block followed by one OVERALL_SUMMARY paragraph

Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${args.reviewCmd}
Caller context, verbatim:
${args.context}

Settled ground not to re-flag:
${formatLines(args.settled)}

Claimed fixed regression checks: confirm each of these is actually gone, report again at its severity if still present, exempt from any reporting bar:
${formatLines(args.claimedFixed)}

Declined findings: report each again if still present, exempt from any bar:
${formatLines(args.declined)}

${formatRoundState(args.round)}
Router ratings: ${routerRatings}
Files classified into this lane: ${classifiedFiles}
Spawned lane set: ${laneNames.join(', ')}

If your own discipline yields a concern to a lane outside the spawned set, report it under that absent owner's tag, name this reporting lane in the body, and do not exceed the top of the absent owner's severity ladder.`
  if (laneName !== 'external') {
    return `${lanePrompt}

Everything above is this run's additions. Your agent definition owns the severity ladder, the finding cap, and the output format; follow it exactly and write nothing after the block it prescribes.`
  }
  const externalLanePrompt = `${lanePrompt}

Find real defects with a concrete failure scenario. LOW is the minimum severity and NIT is forbidden. Anchor each finding to a line the diff adds or removes, or to general for a file-level defect. Emit at most 10 findings, highest severity first, and say in one summary sentence what an overflow dropped.

STRUCTURED_FINDINGS:
- file: <path> | line: <number or general> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM|LOW> | reviewer: external or external/<category> | body: <problem, concrete failure scenario, fix>
- file: ...

OVERALL_SUMMARY:
<one paragraph>

For no findings, put (none) on the line after STRUCTURED_FINDINGS:. Omit side when line is general. Use one finding per line with no bare | inside body.`
  if (args.claudeOnly) {
    return `${externalLanePrompt}\n\nSession routing is Claude-only. Perform an adversarial independent read that tries to refute the other lanes before reporting findings.`
  }
  return `${externalLanePrompt}\n\nWrite the review prompt above to a temp file and run ${codexExecCommandPrefix} gpt-5.6-sol -c model_reasoning_effort=\"high\" < <promptfile>. Return the output verbatim. On a quota, model, or CLI error, return the literal string EXTERNAL_UNAVAILABLE.`
}

function spawnLane(laneName, lanePrompt) {
  const laneDefinition = laneDefinitionsByName.get(laneName)
  if (!laneDefinition) {
    return null
  }
  return laneDefinition.spawn(lanePrompt)
}

function buildJudgmentPrompt(routerResult, laneNames, skippedLaneNames, degradationNotes, droppedFindingCount, cappedLaneNames, groupedFindings, routerFindings, laneSummaries) {
  const routerRatings = routerResult ? `${routerResult.danger}/${routerResult.complexity} via ${routerResult.route}; ${routerResult.dangerFact}` : 'unavailable; no-router default'
  const tiebreakInstruction = args.claudeOnly
    ? 'Session routing is Claude-only, so no external tiebreak exists: isolate the two positions of each contradiction and rule from those positions alone.'
    : `For each contradiction, write both positions to a temp file and run ${grokTiebreakCommand}, then keep the finding its ruling supports.`
  return `Scope: converge findings for changed files ${formatLines(args.changedFiles)} under ${args.reviewCmd}
Out of scope: findings outside that changed-file set, new review work, verdicts, fixes, and recommendations
Definition of done: one final block opened by the exact line STRUCTURED_FINDINGS: (with the trailing colon) followed by one paragraph opened by the exact line OVERALL_SUMMARY: (with the trailing colon), and no trailing text

Grouped lane findings:
${JSON.stringify(groupedFindings)}

Router findings:
${JSON.stringify(routerFindings)}

Lane summaries, supplied only to recognize explicit verified-safe contradictions and overflow reports:
${JSON.stringify(laneSummaries)}

Lanes run: ${laneNames.join(', ')}
Lanes skipped: ${skippedLaneNames.length > 0 ? skippedLaneNames.join(', ') : 'none'}
Degraded: ${degradationNotes.length > 0 ? degradationNotes.join('; ') : 'none'}
Router ratings and route: ${routerRatings}
Dropped outside the changed-file set: ${droppedFindingCount}
Truncated lane tags: ${cappedLaneNames.length > 0 ? cappedLaneNames.join(', ') : 'none'}

Merge findings on the same file within 5 lines, or plainly the same concern in different words, into one finding tagged convergent: <tag> + <tag>. Keep the highest severity and name the lane that assigned it in the body. Convergence confirms confidence but does not itself raise severity. A necessity finding never merges with another lane's finding.

A contradiction is one lane asserting a defect and another explicitly verifying it safe. ${tiebreakInstruction} No ruling available: emit the asserting finding once tagged contested: <asserting lane> vs <disputing lane>, include the disputing reasoning in the body, and end the body with Confidence: low, tiebreak unavailable.

A lane summary may also report findings its own overflow dropped. Treat every lane whose summary reports such an overflow as truncated too, alongside the truncated lane tags supplied above.

Return the reviewer output format exactly. The summary is one paragraph stating how many findings survived, which lanes ran, were skipped, or degraded, the router ratings and route, and the sentence \"Dropped ${droppedFindingCount} finding(s) outside the changed-file set.\" End that paragraph with the verbatim phrase \"truncated lanes: \" followed by the union of the truncated lane tags supplied above and every lane whose summary reports overflow, comma-separated, or by none when that union is empty. Do not return a verdict, risk tier, fix, or recommendation.`
}

if (!args.reviewCmd) {
  return 'No REVIEW_CMD, no run.'
}

if (!Array.isArray(args.changedFiles) || args.changedFiles.length === 0) {
  return 'No changed-file set, no run.'
}

if (typeof args.claudeOnly !== 'boolean') {
  return 'No claudeOnly routing flag, no run.'
}

const filesToClassify = args.round && args.round.number >= 2 ? args.round.touchedFiles : args.changedFiles
const routeOutcome = await routeReview(filesToClassify)
const routerResult = routeOutcome.routerResult
const laneSelection = selectLaneNames(routerResult)
const laneNames = laneSelection.laneNames
log(`Chosen lanes: ${laneNames.join(', ')} because ${laneSelection.reason}.`)

phase('Review')
const lanePrompts = new Map(laneNames.map((laneName) => [laneName, buildLanePrompt(laneName, routerResult, laneNames)]))
const laneTexts = await parallel(laneNames.map((laneName) => () => spawnLane(laneName, lanePrompts.get(laneName))))
const parsedResponses = new Map()
const degradationNotes = routeOutcome.degradationNote === '' ? [] : [routeOutcome.degradationNote]

for (let laneIndex = 0; laneIndex < laneNames.length; laneIndex += 1) {
  const laneName = laneNames[laneIndex]
  const laneText = laneTexts[laneIndex]
  if (laneName === 'external' && (laneText === null || laneText === 'EXTERNAL_UNAVAILABLE')) {
    degradationNotes.push('external unavailable')
    continue
  }
  const parsedResponse = parseLaneResponse(laneText)
  if (blockingLaneNames.has(laneName) && (!parsedResponse.hasParseableBlock || parsedResponse.hasUnparseableRow)) {
    return `LANE_DEATH: ${laneName}`
  }
  if (laneName === 'external' && !parsedResponse.hasParseableBlock) {
    degradationNotes.push('external returned no parseable block')
    continue
  }
  parsedResponses.set(laneName, parsedResponse)
}

if (!routerResult) {
  degradationNotes.push('router unavailable; no-router default lane set used')
}

const changedFileNames = new Set(args.changedFiles.map(normalizeFilePath))
const findingsByFile = new Map()
const parsedRouterFindings = []
let droppedFindingCount = 0

for (const [laneName, parsedResponse] of parsedResponses) {
  for (const parsedFinding of parsedResponse.findings) {
    const findingFileName = parsedFinding.fields.file
    if (!changedFileNames.has(findingFileName)) {
      droppedFindingCount += 1
      continue
    }
    const findingsForFile = findingsByFile.get(findingFileName) || []
    findingsForFile.push({ lane: laneName, line: parsedFinding.raw })
    findingsByFile.set(findingFileName, findingsForFile)
  }
}

for (const routerFindingLine of routerResult ? routerResult.findings || [] : []) {
  const parsedRouterFinding = parseFindingLine(routerFindingLine)
  if (!parsedRouterFinding) {
    continue
  }
  if (!changedFileNames.has(parsedRouterFinding.fields.file)) {
    droppedFindingCount += 1
    continue
  }
  parsedRouterFindings.push(parsedRouterFinding)
}

const rankedRouterFindings = parsedRouterFindings.sort((leftFinding, rightFinding) => severityRankOf(leftFinding) - severityRankOf(rightFinding))
const routerFindings = rankedRouterFindings.slice(0, maxFindingsPerLane).map((parsedFinding) => parsedFinding.raw)

const groupedFindings = [...findingsByFile].map(([file, findings]) => ({ file, findings }))
const cappedLaneNames = [...parsedResponses].filter(([, parsedResponse]) => parsedResponse.hitFindingCap).map(([laneName]) => laneName)
if (rankedRouterFindings.length > routerFindings.length) {
  cappedLaneNames.push('router')
}
const laneSummaries = [...parsedResponses].map(([laneName, parsedResponse]) => ({ lane: laneName, summary: parsedResponse.summary }))
const skippedLaneNames = selectableLaneNames.filter((laneName) => !laneNames.includes(laneName))

phase('Converge')
const judgmentPrompt = buildJudgmentPrompt(routerResult, laneNames, skippedLaneNames, degradationNotes, droppedFindingCount, cappedLaneNames, groupedFindings, routerFindings, laneSummaries)
const convergedFindings = await agent(judgmentPrompt, { model: 'opus', label: 'Converge findings', phase: 'Converge' })
if (!isConvergedBlock(convergedFindings, cappedLaneNames, changedFileNames)) {
  return 'LANE_DEATH: judgment'
}
return convergedFindings
