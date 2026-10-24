import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
export const workflowDirectory = path.join(testDirectory, '..')
const metaExportDeclaration = /^export const meta =/

export function executableSourceOfWorkflow(workflowFileName) {
  const workflowSource = fs.readFileSync(path.join(workflowDirectory, workflowFileName), 'utf8')
  assert.match(workflowSource, metaExportDeclaration, `${workflowFileName} no longer opens with the meta export this test strips to make the workflow evaluable, so evaluating it would fail with a bare SyntaxError. Repoint the declaration pattern before running it again.`)
  return workflowSource.replace(metaExportDeclaration, 'const meta =')
}

export const executableWorkflowSource = executableSourceOfWorkflow('qa-swarm.js')

const orchestrationBoundaryMarker = '\nif (!args.reviewCmd)'
const orchestrationStart = executableWorkflowSource.indexOf(orchestrationBoundaryMarker)

assert.notEqual(orchestrationStart, -1, `qa-swarm.js no longer holds the orchestration boundary marker ${JSON.stringify(orchestrationBoundaryMarker)}, so this test cannot tell which part of the workflow it would evaluate. Repoint the marker before running it again.`)

const functionDefinitions = executableWorkflowSource.slice(0, orchestrationStart)

export function workflowFunctionNamed(functionName, workflowArgs = { repoPath: '/repo' }, runtimeBindings = {}) {
  assert.match(functionDefinitions, new RegExp(`^(?:async )?function ${functionName}\\(`, 'm'), `qa-swarm.js no longer defines ${functionName} above the orchestration boundary, so this test would evaluate less than it claims to cover.`)
  const bindingNames = Object.keys(runtimeBindings)
  const bindingValues = Object.values(runtimeBindings)
  return Function('args', ...bindingNames, `${functionDefinitions}\nreturn ${functionName}`)(workflowArgs, ...bindingValues)
}
