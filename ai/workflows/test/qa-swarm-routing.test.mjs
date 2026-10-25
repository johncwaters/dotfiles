import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executableWorkflowSource, workflowFunctionNamed } from './qa-swarm-source.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function runWorkflow(workflowArgs, runtimeBindings = {}) {
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  return AsyncFunction('args', ...bindingNames, executableWorkflowSource)(workflowArgs, ...bindingValues)
}

const codeLaneOnlyRouterResult = { danger: 'LOW', complexity: 'LOW', dangerFact: 'fixture', fileClasses: [{ file: 'src/file.js', class: 'logic' }], lanes: [], laneJustifications: [], findings: [], route: 'fixture' }

function workflowRuntimeReturning(agentResponseFor) {
  return {
    phase: () => {},
    log: () => {},
    parallel: async (tasks) => Promise.all(tasks.map((task) => task())),
    agent: async (prompt, options) => {
      if (options.phase === 'Route') {
        return codeLaneOnlyRouterResult
      }
      return agentResponseFor(prompt, options)
    }
  }
}

async function emittedRoutingPrompts(workflowArgs) {
  const emittedPrompts = []
  const routerResult = {
    danger: 'LOW',
    complexity: 'LOW',
    dangerFact: 'The test fixture is low risk.',
    fileClasses: [],
    lanes: [],
    laneJustifications: [],
    findings: [],
    route: 'fixture'
  }
  const runtimeBindings = {
    phase: () => {},
    agent: async (prompt) => {
      emittedPrompts.push(prompt)
      return routerResult
    }
  }
  const routeReview = workflowFunctionNamed('routeReview', workflowArgs, runtimeBindings)
  await routeReview(workflowArgs.changedFiles)
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', workflowArgs)
  emittedPrompts.push(buildLanePrompt('code', routerResult, ['code'], workflowArgs.changedFiles, workflowArgs.reviewCmd))
  const buildJudgmentPrompt = workflowFunctionNamed('buildJudgmentPrompt', workflowArgs)
  const convergenceFacts = {
    lanesRun: 'code',
    lanesSkipped: 'none',
    degraded: 'none',
    routerRatings: 'LOW/LOW via fixture',
    droppedFindingCount: 0,
    droppedBelowMediumCount: 0,
    droppedUnprovenCount: 0,
    droppedOutOfLaneCount: 0,
    droppedOutOfLaneTags: 'none',
    truncatedLanes: 'none'
  }
  emittedPrompts.push(buildJudgmentPrompt(convergenceFacts, [], [], [], workflowArgs.changedFiles, workflowArgs.reviewCmd))
  return emittedPrompts
}

const baseWorkflowArgs = {
  reviewCmd: 'git diff base..head',
  repoPath: '/repo',
  context: 'Test routing behavior.',
  changedFiles: ['src/file.js']
}

test('each lane receives its own review checklist heading', () => {
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', baseWorkflowArgs)
  const laneNames = ['code', 'structure']

  for (const laneName of ['code', 'security', 'redteam', 'structure', 'necessity']) {
    const lanePrompt = buildLanePrompt(laneName, null, laneNames, baseWorkflowArgs.changedFiles, baseWorkflowArgs.reviewCmd)

    assert.match(lanePrompt, /~\/\.claude\/review-checklist\.md/)
    assert.ok(lanePrompt.includes(`## ${laneName} as extra checks`))
  }
})

test('a lane or the router reviewing a range executes none of its code while a working tree pin may be run in the repo', () => {
  const rangeReviewCommand = 'git diff aaaa..bbbb'
  const workingTreeReviewCommand = 'git diff HEAD 974f5015bf125022fe199e6fca39041a5fb7b8a4'
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', baseWorkflowArgs)
  const rangeLanePrompt = buildLanePrompt('code', null, ['code'], baseWorkflowArgs.changedFiles, rangeReviewCommand)
  const workingTreeLanePrompt = buildLanePrompt('code', null, ['code'], baseWorkflowArgs.changedFiles, workingTreeReviewCommand)
  const rangeRouterPrompt = workflowFunctionNamed('buildRouterAssessmentPrompt', { ...baseWorkflowArgs, reviewCmd: rangeReviewCommand })(baseWorkflowArgs.changedFiles, 'Route this review.')
  const workingTreeRouterPrompt = workflowFunctionNamed('buildRouterAssessmentPrompt', { ...baseWorkflowArgs, reviewCmd: workingTreeReviewCommand })(baseWorkflowArgs.changedFiles, 'Route this review.')

  assert.match(rangeLanePrompt, /execute none of its code and extract nothing/)
  assert.doesNotMatch(rangeLanePrompt, /git archive/)
  assert.doesNotMatch(rangeLanePrompt, /Run commands in the repo/)
  assert.match(workingTreeLanePrompt, /Run commands in the repo/)
  assert.match(rangeRouterPrompt, /execute none of its code and extract nothing/)
  assert.match(workingTreeRouterPrompt, /Run commands in the repo/)
})

test('a zero-finding lane with verified safe and no overflow converges to a canonical empty block', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nThe claimed defect was verified safe. No overflow.'
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
})

for (const firstLaneResponse of [null, 'not a findings block']) {
  test(`a lane answering ${JSON.stringify(firstLaneResponse)} is retried once with a different prompt and the review converges`, async () => {
    const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nThe claimed defect was verified safe. No overflow.'
    const lanePrompts = []
    const runtimeBindings = workflowRuntimeReturning((prompt) => {
      lanePrompts.push(prompt)
      return lanePrompts.length === 1 ? firstLaneResponse : laneResponse
    })

    const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

    assert.equal(lanePrompts.length, 2)
    assert.notEqual(lanePrompts[1], lanePrompts[0])
    assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
  })
}

test('a lane still dead after its retry is the lane death', async () => {
  const runtimeBindings = workflowRuntimeReturning(() => null)

  assert.equal(await runWorkflow(baseWorkflowArgs, runtimeBindings), 'LANE_DEATH: code')
})

test('a judgment death returns the death string and a new retryAttemptId changes only the retry prompt', async () => {
  const laneResponse = '- file: src/file.js | line: 1 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: Still broken. Proof: `node guard.js` printed undefined.'
  const responsesByLabel = {
    'Code review': `STRUCTURED_FINDINGS:\n${laneResponse}\n\nOVERALL_SUMMARY:\nThe competing interpretation was verified safe.`,
    'Converge findings': 'STRUCTURED_FINDINGS:\n\nOVERALL_SUMMARY:\n0 finding(s) survived. truncated lanes: none',
    'Retry converge findings': 'STRUCTURED_FINDINGS:\n\nOVERALL_SUMMARY:\n0 finding(s) survived. truncated lanes: none'
  }
  const calledLabelsByRun = []
  const promptsByLabel = new Map()
  const runtimeBindings = workflowRuntimeReturning((prompt, options) => {
    const calledLabels = calledLabelsByRun.at(-1)
    calledLabels.push(options.label)
    const prompts = promptsByLabel.get(options.label) ?? []
    prompts.push(prompt)
    promptsByLabel.set(options.label, prompts)
    return responsesByLabel[options.label]
  })

  calledLabelsByRun.push([])
  const firstWorkflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)
  calledLabelsByRun.push([])
  const secondWorkflowResponse = await runWorkflow({ ...baseWorkflowArgs, retryAttemptId: 'second attempt' }, runtimeBindings)

  assert.equal(firstWorkflowResponse, 'LANE_DEATH: judgment')
  assert.equal(secondWorkflowResponse, 'LANE_DEATH: judgment')
  assert.deepEqual(calledLabelsByRun, [
    ['Code review', 'Converge findings', 'Retry converge findings'],
    ['Code review', 'Converge findings', 'Retry converge findings']
  ])
  assert.notEqual(promptsByLabel.get('Retry converge findings')[0], promptsByLabel.get('Retry converge findings')[1])
  assert.equal(promptsByLabel.get('Converge findings')[0], promptsByLabel.get('Converge findings')[1])
})

test('a lane summary denying overflow converges mechanically and keeps its finding', async () => {
  const findingLine = '- file: src/file.js | line: 12 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: The guard is missing. Proof: `node guard.js` printed undefined.'
  const laneResponse = `STRUCTURED_FINDINGS:\n${findingLine}\n\nOVERALL_SUMMARY:\nOne defect stands. No overflow.`
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.ok(workflowResponse.includes(findingLine))
  assert.match(workflowResponse, /truncated lanes: none$/)
})

test('a finding whose body carries no Proof: is dropped before convergence and counted', async () => {
  const provenFindingLine = '- file: src/file.js | line: 12 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: The guard is missing. **Proof**: `node guard.js` printed undefined.'
  const theorizedFindingLine = '- file: src/file.js | line: 30 | side: RIGHT | severity: HIGH | reviewer: code/race | body: A concurrent caller could interleave here.'
  const laneResponse = `STRUCTURED_FINDINGS:\n${theorizedFindingLine}\n${provenFindingLine}\n\nOVERALL_SUMMARY:\nNo overflow.`
  const runtimeBindings = workflowRuntimeReturning(() => laneResponse)

  const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

  assert.ok(workflowResponse.includes(provenFindingLine))
  assert.ok(!workflowResponse.includes(theorizedFindingLine))
  assert.match(workflowResponse, /1 finding\(s\) survived\..* Dropped unproven: 1\./)
})

test('a lane summary reporting overflow lands in the truncated lane list when every finding is dropped', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n- file: src/other.js | line: 3 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: The guard is missing. Proof: `node guard.js` printed undefined.\n\nOVERALL_SUMMARY:\nOverflow dropped 3 further findings.'
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
  assert.match(workflowResponse, /truncated lanes: code$/)
})

test('a zero-finding lane discussing arithmetic overflow stays out of the truncated lane list', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nThe index cannot overflow; integer overflow is guarded.'
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(baseWorkflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
  assert.match(workflowResponse, /truncated lanes: none$/)
})

