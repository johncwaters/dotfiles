#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

function laneFromLabel(label) {
  return String(label ?? '').toLowerCase().replace(/^retry /, '').replace(/ (review|findings)$/, '').replace(/[^a-z]/g, '')
}

function lanesFromReviewerTags(reviewerField, reviewLanes) {
  const taggedWords = String(reviewerField).toLowerCase().match(/[a-z-]+/g) ?? []
  return [...new Set(taggedWords.map((word) => word.replace(/-/g, '')).filter((word) => reviewLanes.has(word)))]
}

function findingRowsFrom(resultText, reviewLanes) {
  if (typeof resultText !== 'string') return []
  return resultText.split('\n').flatMap((line) => {
    const severity = line.match(/\| severity: ([A-Z]+) \|/)?.[1]
    const reviewer = line.match(/\| reviewer: ([^|]+) \|/)?.[1]
    if (!line.startsWith('- file:') || !severities.includes(severity) || !reviewer) return []
    return [{ severity, lanes: lanesFromReviewerTags(reviewer, reviewLanes) }]
  })
}

function workflowRunFiles() {
  const projectsDirectory = join(homedir(), '.claude', 'projects')
  const readDirectory = (directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
    } catch {
      return []
    }
  }
  return readDirectory(projectsDirectory).filter((entry) => entry.isDirectory()).flatMap((project) =>
    readDirectory(join(projectsDirectory, project.name)).filter((entry) => entry.isDirectory()).flatMap((session) => {
      const workflowsDirectory = join(projectsDirectory, project.name, session.name, 'workflows')
      return readDirectory(workflowsDirectory).filter((entry) => /^wf_.*\.json$/.test(entry.name)).map((entry) => join(workflowsDirectory, entry.name))
    }))
}

function readQaSwarmRun(runFile) {
  try {
    const run = JSON.parse(readFileSync(runFile, 'utf8'))
    return run?.workflowName === 'qa-swarm' && Array.isArray(run.workflowProgress) ? run : null
  } catch {
    return null
  }
}

function emptyLaneRow() {
  return { runs: 0, tokens: 0, durationMs: 0, findingsBySeverity: Object.fromEntries(severities.map((severity) => [severity, 0])) }
}

function laneRowsByMonth() {
  const rowsByMonth = new Map()
  const laneRowFor = (month, lane) => {
    if (!rowsByMonth.has(month)) rowsByMonth.set(month, new Map())
    const laneRows = rowsByMonth.get(month)
    if (!laneRows.has(lane)) laneRows.set(lane, emptyLaneRow())
    return laneRows.get(lane)
  }
  for (const runFile of workflowRunFiles()) {
    const run = readQaSwarmRun(runFile)
    if (!run) continue
    const month = new Date(run.startTime ?? run.timestamp ?? 0).toISOString().slice(0, 7)
    const agentEntries = run.workflowProgress.filter((entry) => entry?.type === 'workflow_agent')
    for (const lane of new Set(agentEntries.map((entry) => laneFromLabel(entry.label)))) laneRowFor(month, lane).runs += 1
    for (const entry of agentEntries) {
      const laneRow = laneRowFor(month, laneFromLabel(entry.label))
      laneRow.tokens += Number(entry.tokens) || 0
      laneRow.durationMs += Number(entry.durationMs) || 0
    }
    const reviewLanes = new Set(agentEntries.filter((entry) => entry.phaseTitle === 'Review').map((entry) => laneFromLabel(entry.label)))
    for (const finding of findingRowsFrom(run.result, reviewLanes)) {
      for (const lane of finding.lanes) laneRowFor(month, lane).findingsBySeverity[finding.severity] += 1
    }
  }
  return rowsByMonth
}

function printTable(table) {
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => String(row[column]).length)))
  for (const row of table) console.log(row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd())
}

function reportLanes() {
  const table = [['Month', 'Lane', 'Runs', 'Tokens', 'Minutes', ...severities]]
  const rowsByMonth = laneRowsByMonth()
  for (const month of [...rowsByMonth.keys()].sort()) {
    for (const [lane, laneRow] of [...rowsByMonth.get(month)].sort(([left], [right]) => left.localeCompare(right))) {
      table.push([month, lane, laneRow.runs, laneRow.tokens, Math.round(laneRow.durationMs / 60000), ...severities.map((severity) => laneRow.findingsBySeverity[severity])])
    }
  }
  printTable(table)
}

reportLanes()
