import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executableWorkflowSource, workflowFunctionNamed } from './qa-swarm-source.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function runWorkflow(workflowArgs) {
  return AsyncFunction('args', executableWorkflowSource)(workflowArgs)
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
