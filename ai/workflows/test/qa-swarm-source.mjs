import assert from 'node:assert/strict'
import { executableSourceOfWorkflow } from '../agy/host.mjs'

export { executableSourceOfWorkflow, workflowDirectory } from '../agy/host.mjs'

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
