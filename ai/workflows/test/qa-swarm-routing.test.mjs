import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executableWorkflowSource, workflowFunctionNamed } from './qa-swarm-source.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function runWorkflow(workflowArgs, runtimeBindings = {}) {
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  return AsyncFunction('args', ...bindingNames, executableWorkflowSource)(workflowArgs, ...bindingValues)
}

function workflowRuntimeReturning(agentResponseFor) {
  return {
    phase: () => {},
    log: () => {},
    parallel: async (tasks) => Promise.all(tasks.map((task) => task())),
    agent: async (prompt, options) => agentResponseFor(prompt, options)
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
  emittedPrompts.push(buildLanePrompt('external', routerResult, ['code', 'external'], workflowArgs.changedFiles, workflowArgs.reviewCmd, false, false))
  const buildJudgmentPrompt = workflowFunctionNamed('buildJudgmentPrompt', workflowArgs)
  const convergenceFacts = {
    lanesRun: 'code, external',
    lanesSkipped: 'none',
    degraded: 'none',
    routerRatings: 'LOW/LOW via fixture',
    droppedFindingCount: 0,
    droppedBelowMediumCount: 0,
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
  changedFiles: ['src/file.js'],
  codexAllowed: true,
  grokAllowed: true,
  settled: [],
  claimedFixed: [],
  declined: []
}

test('the workflow refuses to run when either routing flag is missing', async () => {
  const refusalMessage = 'No valid codexAllowed and grokAllowed routing flags, no run.'

  assert.equal(await runWorkflow({ ...baseWorkflowArgs, codexAllowed: undefined }), refusalMessage)
  assert.equal(await runWorkflow({ ...baseWorkflowArgs, grokAllowed: undefined }), refusalMessage)
})

test('disabling Codex emits no Codex execution instruction in any prompt', async () => {
  const emittedPrompts = await emittedRoutingPrompts({ ...baseWorkflowArgs, codexAllowed: false })

  assert.doesNotMatch(emittedPrompts.join('\n'), /codex exec/)
  assert.match(emittedPrompts.join('\n'), /Codex CLI/)
})

test('disabling Grok keeps Codex instructions and emits no Grok execution instruction', async () => {
  const emittedPrompts = await emittedRoutingPrompts({ ...baseWorkflowArgs, grokAllowed: false })
  const combinedPrompts = emittedPrompts.join('\n')

  assert.match(combinedPrompts, /codex exec/)
  assert.doesNotMatch(combinedPrompts, /grok --prompt-file/)
  assert.match(combinedPrompts, /Grok CLI/)
})

async function routedAfterDispatcherReturns(dispatcherRoute) {
  const routerResultFor = (route) => ({ danger: 'LOW', complexity: 'LOW', dangerFact: 'fixture', fileClasses: [], lanes: [], laneJustifications: [], findings: [], route })
  const spawnedModels = []
  const runtimeBindings = {
    phase: () => {},
    agent: async (prompt, options) => {
      spawnedModels.push(options.model)
      return routerResultFor(options.model === 'sonnet' ? dispatcherRoute : 'ignored')
    }
  }
  const routeReview = workflowFunctionNamed('routeReview', baseWorkflowArgs, runtimeBindings)
  const routed = await routeReview(baseWorkflowArgs.changedFiles)
  return { ...routed, spawnedModels }
}

test('a dispatcher that answers the router itself instead of running Codex falls back to opus with a degradation note', async () => {
  const routed = await routedAfterDispatcherReturns('sonnet-direct')

  assert.deepEqual(routed.spawnedModels, ['sonnet', 'opus'])
  assert.equal(routed.routerResult.route, 'opus')
  assert.match(routed.degradationNote, /unexpected route "sonnet-direct"/)
})

test('Codex dispatch goes through the codex-dispatcher agent under the read-only credential-denying profile', async () => {
  const dispatchSpawns = []
  const runtimeBindings = {
    phase: () => {},
    agent: async (prompt, options) => {
      dispatchSpawns.push({ prompt, options })
      return { danger: 'LOW', complexity: 'LOW', dangerFact: 'fixture', fileClasses: [], lanes: [], laneJustifications: [], findings: [], route: 'gpt-6-sol' }
    }
  }
  const routeReview = workflowFunctionNamed('routeReview', baseWorkflowArgs, runtimeBindings)
  await routeReview(baseWorkflowArgs.changedFiles)
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', baseWorkflowArgs)
  const externalPrompt = buildLanePrompt('external', null, ['code', 'external'], baseWorkflowArgs.changedFiles, baseWorkflowArgs.reviewCmd, false, false)

  assert.equal(dispatchSpawns[0].options.agentType, 'codex-dispatcher')
  for (const prompt of [dispatchSpawns[0].prompt, externalPrompt]) {
    assert.match(prompt, /codex exec -c 'permissions\.qa_review=\{extends=":read-only"/)
    assert.match(prompt, /"~\/\.ssh"="deny".* -c 'default_permissions="qa_review"' -C \/repo -m gpt-6-sol/)
    assert.doesNotMatch(prompt, /dangerously/)
  }
})

test('a session without the codex-dispatcher agent type routes on opus instead of crashing', async () => {
  const spawnedModels = []
  const runtimeBindings = {
    phase: () => {},
    log: () => {},
    agent: async (prompt, options) => {
      spawnedModels.push(options.model)
      if (options.agentType === 'codex-dispatcher') {
        throw new Error("agent type 'codex-dispatcher' not found")
      }
      return { danger: 'LOW', complexity: 'LOW', dangerFact: 'fixture', fileClasses: [], lanes: [], laneJustifications: [], findings: [], route: 'ignored' }
    }
  }
  const routeReview = workflowFunctionNamed('routeReview', baseWorkflowArgs, runtimeBindings)
  const routed = await routeReview(baseWorkflowArgs.changedFiles)

  assert.deepEqual(spawnedModels, ['sonnet', 'opus'])
  assert.equal(routed.routerResult.route, 'opus')
  assert.match(routed.degradationNote, /router agent death/)
})

test('a router answer from a Codex model is accepted without an opus fallback', async () => {
  const routed = await routedAfterDispatcherReturns('gpt-6-luna')

  assert.deepEqual(routed.spawnedModels, ['sonnet'])
  assert.equal(routed.routerResult.route, 'gpt-6-luna')
  assert.equal(routed.degradationNote, '')
})

test('a zero-finding lane with verified safe and no overflow converges to a canonical empty block', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nThe claimed defect was verified safe. No overflow.'
  const workflowArgs = {
    ...baseWorkflowArgs,
    round: { number: 2, touchedFiles: ['src/file.js'], reportingBar: 'none' }
  }
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(workflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
})

test('a judgment death returns the death string and a new retryAttemptId changes only the retry prompt', async () => {
  const laneResponse = '- file: src/file.js | line: 1 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: Still broken.'
  const responsesByLabel = {
    'Code review': `STRUCTURED_FINDINGS:\n${laneResponse}\n\nOVERALL_SUMMARY:\nThe competing interpretation was verified safe.`,
    'Converge findings': 'STRUCTURED_FINDINGS:\n\nOVERALL_SUMMARY:\n0 finding(s) survived. truncated lanes: none',
    'Retry converge findings': 'STRUCTURED_FINDINGS:\n\nOVERALL_SUMMARY:\n0 finding(s) survived. truncated lanes: none'
  }
  const workflowArgs = {
    ...baseWorkflowArgs,
    round: { number: 2, touchedFiles: ['src/file.js'], reportingBar: 'none' }
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
  const firstWorkflowResponse = await runWorkflow(workflowArgs, runtimeBindings)
  calledLabelsByRun.push([])
  const secondWorkflowResponse = await runWorkflow({ ...workflowArgs, retryAttemptId: 'second attempt' }, runtimeBindings)

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
  const findingLine = '- file: src/file.js | line: 12 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: The guard is missing.'
  const laneResponse = `STRUCTURED_FINDINGS:\n${findingLine}\n\nOVERALL_SUMMARY:\nOne defect stands. No overflow.`
  const workflowArgs = {
    ...baseWorkflowArgs,
    round: { number: 2, touchedFiles: ['src/file.js'], reportingBar: 'none' }
  }
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(workflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.ok(workflowResponse.includes(findingLine))
  assert.match(workflowResponse, /truncated lanes: none$/)
})

test('a lane summary reporting overflow lands in the truncated lane list when every finding is dropped', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n- file: src/other.js | line: 3 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: The guard is missing.\n\nOVERALL_SUMMARY:\nOverflow dropped 3 further findings.'
  const workflowArgs = {
    ...baseWorkflowArgs,
    changedFiles: ['src/file.js', 'src/other.js'],
    round: { number: 2, touchedFiles: ['src/file.js'], reportingBar: 'none' }
  }
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(workflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
  assert.match(workflowResponse, /truncated lanes: code$/)
})

test('a zero-finding lane discussing arithmetic overflow stays out of the truncated lane list', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nThe index cannot overflow; integer overflow is guarded.'
  const workflowArgs = {
    ...baseWorkflowArgs,
    round: { number: 2, touchedFiles: ['src/file.js'], reportingBar: 'none' }
  }
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return laneResponse
  })

  const workflowResponse = await runWorkflow(workflowArgs, runtimeBindings)

  assert.equal(agentCallCount, 1)
  assert.match(workflowResponse, /^STRUCTURED_FINDINGS:\n\(none\)\n\nOVERALL_SUMMARY:\n0 finding\(s\) survived\./)
  assert.match(workflowResponse, /truncated lanes: none$/)
})
