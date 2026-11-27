import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const workflowDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const metaExportDeclaration = /^export const meta =/
const workflowNamePattern = /^[a-z][a-z0-9-]*$/
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export function executableSourceOfWorkflow(workflowFileName) {
  const workflowSource = fs.readFileSync(path.join(workflowDirectory, workflowFileName), 'utf8')
  if (!metaExportDeclaration.test(workflowSource)) throw new Error(`${workflowFileName} no longer opens with the meta export this host strips to evaluate it`)
  return workflowSource.replace(metaExportDeclaration, 'const meta =')
}

export function runWorkflow(workflowFileName, workflowArgs, runtimeBindings) {
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  return AsyncFunction('args', ...bindingNames, executableSourceOfWorkflow(workflowFileName))(workflowArgs, ...bindingValues)
}

function channelBindings(send) {
  const resolveByRequestId = new Map()
  let nextRequestId = 1
  const bindings = {
    agent: (prompt, options = {}) => new Promise((resolve) => {
      const requestId = nextRequestId++
      resolveByRequestId.set(requestId, resolve)
      send({ op: 'agent', id: requestId, prompt, agentType: options.agentType ?? null, schema: options.schema ?? null })
    }),
    parallel: (tasks) => Promise.all(tasks.map((task) => Promise.resolve().then(task).catch(() => null))),
    phase: (phaseName) => send({ op: 'phase', name: phaseName }),
    log: (...parts) => send({ op: 'log', text: parts.join(' ') })
  }
  const settleReply = (reply) => {
    const resolve = resolveByRequestId.get(reply.id)
    resolveByRequestId.delete(reply.id)
    resolve?.(reply.ok ? reply.value : null)
  }
  return { bindings, settleReply }
}

async function serveWorkflowOverStdio(workflowName) {
  if (!workflowNamePattern.test(workflowName ?? '')) throw new Error(`not a workflow name: ${workflowName}`)
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const { bindings, settleReply } = channelBindings(send)
  let workflowRun = null
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line)
    if (workflowRun) {
      settleReply(message)
      continue
    }
    workflowRun = runWorkflow(`${workflowName}.js`, message.args, bindings).then((workflowResult) => {
      process.stdout.write(`${JSON.stringify({ op: 'done', value: workflowResult ?? null })}\n`, () => process.exit(0))
    })
  }
  if (workflowRun) await workflowRun
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await serveWorkflowOverStdio(process.argv[2])
