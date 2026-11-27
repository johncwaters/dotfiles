import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runWorkflow, workflowDirectory } from './host.mjs'

const workflowNamePattern = /^[a-z][a-z0-9-]*$/
const laneTimeoutMs = 30 * 60 * 1000
const frontmatterBlock = /^---\n[\s\S]*?\n---\n/

function laneInstructionsOf(agentType) {
  if (!agentType) return null
  const laneDefinition = fs.readFileSync(path.join(workflowDirectory, '..', 'agents', `${agentType}.md`), 'utf8')
  if (!frontmatterBlock.test(laneDefinition)) throw new Error(`${agentType}.md has no frontmatter to strip`)
  return laneDefinition.replace(frontmatterBlock, '').trim()
}

function strictSchemaOf(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchemaOf)
  if (!schema || typeof schema !== 'object') return schema
  const strictSchema = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strictSchemaOf(value)]))
  if (schema.type !== 'object' || !schema.properties) return strictSchema
  return { ...strictSchema, additionalProperties: false, required: Object.keys(schema.properties) }
}

function codexExecArguments(laneDirectory, laneInstructions, schemaPath, lastMessagePath) {
  const codexArguments = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-C', laneDirectory, '-o', lastMessagePath]
  if (laneInstructions) codexArguments.push('-c', `developer_instructions=${JSON.stringify(laneInstructions)}`)
  if (schemaPath) codexArguments.push('--output-schema', schemaPath)
  return [...codexArguments, '-']
}

function runCodex(codexArguments, prompt) {
  return new Promise((resolve) => {
    const codex = spawn('codex', codexArguments, { stdio: ['pipe', 'ignore', 'inherit'] })
    const timeout = setTimeout(() => codex.kill('SIGTERM'), laneTimeoutMs)
    codex.on('error', () => resolve(1))
    codex.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode ?? 1)
    })
    codex.stdin.end(prompt)
  })
}

async function runCodexLane(prompt, options, repoPath) {
  const laneDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lane-'))
  try {
    const schemaPath = options.schema ? path.join(laneDirectory, 'schema.json') : null
    if (schemaPath) fs.writeFileSync(schemaPath, JSON.stringify(strictSchemaOf(options.schema)))
    const lastMessagePath = path.join(laneDirectory, 'last-message.txt')
    const repoPreamble = `Run every command against the repo at ${repoPath} (cd there first); it is read-only to you, and scratch files go under mktemp -d.\n\n`
    const exitCode = await runCodex(codexExecArguments(laneDirectory, laneInstructionsOf(options.agentType), schemaPath, lastMessagePath), repoPreamble + prompt)
    if (exitCode !== 0 || !fs.existsSync(lastMessagePath)) return null
    const lastMessage = fs.readFileSync(lastMessagePath, 'utf8')
    return schemaPath ? JSON.parse(lastMessage) : lastMessage
  } catch (laneFailure) {
    process.stderr.write(`${options.agentType ?? 'self'} lane failed: ${laneFailure.message}\n`)
    return null
  } finally {
    fs.rmSync(laneDirectory, { recursive: true, force: true })
  }
}

const [workflowName, argsPath] = process.argv.slice(2)
if (!workflowNamePattern.test(workflowName ?? '') || !argsPath) {
  process.stderr.write('usage: codex-workflow.mjs <workflow> <args.json>\n')
  process.exit(2)
}
const workflowArgs = JSON.parse(fs.readFileSync(argsPath, 'utf8'))
const repoPath = workflowArgs.repoPath ?? process.cwd()
const workflowResult = await runWorkflow(`${workflowName}.js`, workflowArgs, {
  agent: (prompt, options = {}) => runCodexLane(prompt, options, repoPath),
  parallel: (tasks) => Promise.all(tasks.map((task) => Promise.resolve().then(task).catch(() => null))),
  phase: (phaseName) => process.stderr.write(`phase: ${phaseName}\n`),
  log: (...parts) => process.stderr.write(`${parts.join(' ')}\n`)
})
process.stdout.write(`${JSON.stringify(workflowResult ?? null)}\n`)
