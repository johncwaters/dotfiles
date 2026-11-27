import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { runWorkflow, workflowDirectory } from '../agy/host.mjs'

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
  return runWorkflow(workflowFileName, workflowArgs, runtimeBindings).then(() => agentCalls)
}

async function runWorkflowThroughAgyHost(workflowFileName, workflowArgs) {
  const hostProcess = spawn(process.execPath, [path.join(workflowDirectory, 'agy', 'host.mjs'), path.basename(workflowFileName, '.js')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const hostExit = new Promise((resolve) => hostProcess.on('exit', resolve))
  hostProcess.stdin.write(`${JSON.stringify({ args: workflowArgs })}\n`)
  const agentRequests = []
  let doneMessage = null
  for await (const line of readline.createInterface({ input: hostProcess.stdout })) {
    const message = JSON.parse(line)
    if (message.op === 'done') doneMessage = message
    if (message.op !== 'agent') continue
    agentRequests.push(message)
    hostProcess.stdin.write(`${JSON.stringify({ id: message.id, ok: false })}\n`)
  }
  return { agentRequests, doneMessage, exitCode: await hostExit }
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

for (const workflowFileName of workflowFileNames) {
  test(`${workflowFileName} sends agy the same agent calls through the host channel and still returns`, async () => {
    const workflowArgs = workflowArgsByFileName[workflowFileName]
    const inProcessCalls = await runWorkflowWithFailingAgents(workflowFileName, workflowArgs)
    const { agentRequests, doneMessage, exitCode } = await runWorkflowThroughAgyHost(workflowFileName, workflowArgs)
    assert.equal(exitCode, 0)
    assert.ok(doneMessage, 'the host exited without sending done, so agy would report the workflow as failed')
    const hostCallKeys = agentRequests.map((request) => JSON.stringify([request.prompt, request.agentType, request.schema])).sort()
    const inProcessCallKeys = inProcessCalls.map((agentCall) => JSON.stringify([agentCall.prompt, agentCall.options?.agentType ?? null, agentCall.options?.schema ?? null])).sort()
    assert.deepEqual(hostCallKeys, inProcessCallKeys)
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
