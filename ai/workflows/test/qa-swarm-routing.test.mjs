import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { executableWorkflowSource, workflowFunctionNamed } from './qa-swarm-source.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function runWorkflow(workflowArgs, runtimeBindings = {}) {
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  return AsyncFunction('args', ...bindingNames, executableWorkflowSource)(workflowArgs, ...bindingValues)
}

function workflowRuntimeReturning(agentResponseFor, routerAnswer = { lanes: [], reason: 'no trigger met' }) {
  return {
    phase: () => {},
    log: () => {},
    parallel: async (tasks) => Promise.all(tasks.map((task) => task())),
    agent: async (prompt, options) => {
      if (options.phase === 'Route') {
        return routerAnswer
      }
      return agentResponseFor(prompt, options)
    }
  }
}

const baseWorkflowArgs = {
  reviewCmd: 'git diff base..head',
  repoPath: '/repo',
  context: 'Test routing behavior.',
  changedFiles: ['src/file.js'],
  ruleLanes: { lanes: ['code'], filesByLane: { code: ['src/file.js'] } }
}

test('each lane receives its own review checklist heading and the finding bar', () => {
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', baseWorkflowArgs)

  for (const laneName of ['code', 'security', 'redteam', 'boundary']) {
    const lanePrompt = buildLanePrompt(laneName, baseWorkflowArgs.changedFiles, baseWorkflowArgs.changedFiles, baseWorkflowArgs.reviewCmd)

    assert.match(lanePrompt, /~\/\.claude\/review-checklist\.md/)
    assert.ok(lanePrompt.includes(`## ${laneName} as extra checks`))
    assert.match(lanePrompt, /style concerns are not findings/)
  }
})

test('a lane or the router reviewing a range executes none of its code while a working tree pin may be run in the repo', () => {
  const rangeReviewCommand = 'git diff aaaa..bbbb'
  const workingTreeReviewCommand = 'git diff HEAD 974f5015bf125022fe199e6fca39041a5fb7b8a4'
  const buildLanePrompt = workflowFunctionNamed('buildLanePrompt', baseWorkflowArgs)
  const rangeLanePrompt = buildLanePrompt('code', [], baseWorkflowArgs.changedFiles, rangeReviewCommand)
  const workingTreeLanePrompt = buildLanePrompt('code', [], baseWorkflowArgs.changedFiles, workingTreeReviewCommand)
  const rangeRouterPrompt = workflowFunctionNamed('buildRouterPrompt', { ...baseWorkflowArgs, reviewCmd: rangeReviewCommand })(['security'], baseWorkflowArgs.changedFiles)
  const workingTreeRouterPrompt = workflowFunctionNamed('buildRouterPrompt', { ...baseWorkflowArgs, reviewCmd: workingTreeReviewCommand })(['security'], baseWorkflowArgs.changedFiles)

  assert.match(rangeLanePrompt, /execute none of its code and extract nothing/)
  assert.doesNotMatch(rangeLanePrompt, /git archive/)
  assert.doesNotMatch(rangeLanePrompt, /Run commands in the repo/)
  assert.match(workingTreeLanePrompt, /Run commands in the repo/)
  assert.match(rangeRouterPrompt, /execute none of its code and extract nothing/)
  assert.match(workingTreeRouterPrompt, /Run commands in the repo/)
  const convergingRoundReviewCommand = 'git diff 5ce9c5514e0f8a3b1c2d4e6f7a8b9c0d1e2f3a4b 451d83f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
  assert.match(buildLanePrompt('code', [], baseWorkflowArgs.changedFiles, convergingRoundReviewCommand), /Run commands in the repo/)
  assert.match(workflowFunctionNamed('buildRouterPrompt', { ...baseWorkflowArgs, reviewCmd: convergingRoundReviewCommand })(['security'], baseWorkflowArgs.changedFiles), /Run commands in the repo/)
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


test('a run without rule lanes is refused before any agent starts', async () => {
  let agentCallCount = 0
  const runtimeBindings = workflowRuntimeReturning(() => {
    agentCallCount += 1
    return null
  })

  assert.equal(await runWorkflow({ ...baseWorkflowArgs, ruleLanes: undefined }, runtimeBindings), 'No rule lanes, no run.')
  assert.equal(agentCallCount, 0)
})

test('the router only adds an unpicked lane naming a changed file, even as a diff path, and a dead router leaves the rule lanes running', async () => {
  const laneResponse = 'STRUCTURED_FINDINGS:\n(none)\n\nOVERALL_SUMMARY:\nNo overflow.'
  const addingRouterAnswer = { lanes: [{ lane: 'redteam', file: 'b/src/file.js' }, { lane: 'security', file: 'src/elsewhere.js' }, { lane: 'code', file: 'src/file.js' }] }
  const spawnedLabels = []
  const addingRuntime = workflowRuntimeReturning((prompt, options) => {
    spawnedLabels.push(options.label)
    return laneResponse
  }, addingRouterAnswer)

  const addingResponse = await runWorkflow(baseWorkflowArgs, addingRuntime)

  assert.deepEqual(spawnedLabels.sort(), ['Code review', 'Red-team review'])
  assert.match(addingResponse, /Lanes run: code, redteam\. Lanes skipped: security, boundary\./)

  const deadRouterResponse = await runWorkflow(baseWorkflowArgs, workflowRuntimeReturning(() => laneResponse, null))
  const loggedLines = []
  await runWorkflow(baseWorkflowArgs, { ...workflowRuntimeReturning(() => laneResponse), log: (line) => loggedLines.push(line) })
  assert.ok(loggedLines.includes('Router added lanes: none (no trigger met).'))

  assert.match(deadRouterResponse, /Lanes run: code\..*Degraded: router unavailable; rule lanes only\./)
})

test('route-lanes picks the same lanes from a pinned diff on every run, docs alone getting only code', (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'route-lanes-'))
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }))
  const git = (...gitArguments) => execFileSync('git', ['-C', repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', ...gitArguments], { encoding: 'utf8' }).trim()
  git('init', '-q')
  fs.mkdirSync(path.join(repoPath, 'src'))
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'start\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const baseCommit = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repoPath, 'src/quota-gate.js'), 'export const bearerToken = process.env.API_TOKEN\n')
  fs.appendFileSync(path.join(repoPath, 'README.md'), 'more\n')
  git('add', '-A')
  git('commit', '-qm', 'change')
  const routeLanesScript = path.join(import.meta.dirname, '../../skills/reviewing-code/scripts/route-lanes.mjs')
  const routeLanes = (reviewCmd, changedFiles, extraFlags = []) => JSON.parse(execFileSync(process.execPath, [routeLanesScript, '--review-cmd', reviewCmd, '--repo', repoPath, ...extraFlags, '--', ...changedFiles], { encoding: 'utf8' }))

  const codeChange = routeLanes(`git diff ${baseCommit} HEAD`, ['README.md', 'src/quota-gate.js'])

  assert.deepEqual(codeChange, routeLanes(`git diff ${baseCommit} HEAD`, ['README.md', 'src/quota-gate.js']))
  assert.deepEqual(codeChange.lanes, ['code', 'security', 'redteam', 'boundary'])
  assert.deepEqual(codeChange.filesByLane.boundary, ['src/quota-gate.js'])
  assert.deepEqual(codeChange.filesByLane.redteam, ['src/quota-gate.js'])
  assert.deepEqual(routeLanes(`git diff ${baseCommit} HEAD -- README.md`, ['README.md']).lanes, ['code'])
  const allLanes = routeLanes(`git diff ${baseCommit} HEAD`, ['README.md', 'src/quota-gate.js'], ['--all-lanes'])
  assert.deepEqual(allLanes.filesByLane, { code: ['README.md', 'src/quota-gate.js'], security: ['README.md', 'src/quota-gate.js'], redteam: ['src/quota-gate.js'], boundary: ['src/quota-gate.js'] })
  assert.deepEqual(routeLanes(`git diff ${baseCommit} HEAD -- README.md`, ['README.md'], ['--all-lanes']).lanes, ['code', 'security'])
})
