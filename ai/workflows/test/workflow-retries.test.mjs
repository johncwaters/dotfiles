import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { executableSourceOfWorkflow, workflowDirectory } from './qa-swarm-source.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const workflowArgsByFileName = {
  'plan-challenge.js': { goal: 'Ship the fixture.', planText: '1. First step\n2. Second step\n', repoPath: '/repo', lanes: ['scale'] },
  'qa-swarm.js': { reviewCmd: 'git diff HEAD', repoPath: '/repo', context: 'fixture', changedFiles: ['src/file.js'], ruleLanes: { lanes: ['code', 'security'], filesByLane: { code: ['src/file.js'], security: ['src/file.js'] } } }
}

function runWorkflowWithFailingAgents(workflowFileName, workflowArgs) {
  const agentCalls = []
  const runtimeBindings = {
    phase: () => {},
    log: () => {},
    parallel: async (tasks) => Promise.all(tasks.map((task) => task())),
    agent: async (prompt, options) => {
      agentCalls.push({ prompt, options })
      return null
    }
  }
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  const workflowRun = AsyncFunction('args', ...bindingNames, executableSourceOfWorkflow(workflowFileName))(workflowArgs, ...bindingValues)
  return workflowRun.then(() => agentCalls)
}

const workflowFileNames = fs.readdirSync(workflowDirectory).filter((fileName) => fileName.endsWith('.js'))

for (const workflowFileName of workflowFileNames) {
  test(`${workflowFileName} never resends an identical agent call when every agent fails`, async () => {
    const workflowArgs = workflowArgsByFileName[workflowFileName]
    assert.ok(workflowArgs, `${workflowFileName} has no fixture args in workflowArgsByFileName, so its retries go unchecked. Add one.`)
    const agentCalls = await runWorkflowWithFailingAgents(workflowFileName, workflowArgs)
    const agentCallKeys = agentCalls.map((agentCall) => JSON.stringify([agentCall.prompt, agentCall.options]))
    assert.ok(agentCalls.length > 0)
    assert.equal(new Set(agentCallKeys).size, agentCallKeys.length)
  })
}

test('a new retryAttemptId changes only the plan-challenge retry prompts', async () => {
  const baseWorkflowArgs = workflowArgsByFileName['plan-challenge.js']
  const firstRunCalls = await runWorkflowWithFailingAgents('plan-challenge.js', baseWorkflowArgs)
  const secondRunCalls = await runWorkflowWithFailingAgents('plan-challenge.js', { ...baseWorkflowArgs, retryAttemptId: 'second attempt' })
  const firstRunPrompts = firstRunCalls.map((agentCall) => agentCall.prompt)
  const secondRunPrompts = secondRunCalls.map((agentCall) => agentCall.prompt)

  assert.equal(firstRunPrompts.length, 4)
  assert.deepEqual(secondRunPrompts.slice(0, 2), firstRunPrompts.slice(0, 2))
  for (let retryIndex = 2; retryIndex < 4; retryIndex += 1) {
    assert.notEqual(secondRunPrompts[retryIndex], firstRunPrompts[retryIndex])
  }
})
