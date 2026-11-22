#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Git } from '../../landing/lib/git.ts'
import { readReviewLedger } from '../../landing/lib/stamp.ts'

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
  return { actionable: 0, runs: 0, tokens: 0, durationMs: 0, findingsBySeverity: Object.fromEntries(severities.map((severity) => [severity, 0])) }
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
  for (const ledgerRow of readReviewLedger()) {
    const taggedLanes = ledgerRow.reviewedFindings.flatMap((finding) => [...String(finding?.reviewer).matchAll(/([a-z-]+)\//g)].map((match) => match[1]))
    const reviewLanes = new Set((ledgerRow.lanes.length > 0 ? ledgerRow.lanes : taggedLanes).map((lane) => laneFromLabel(lane)))
    for (const finding of ledgerRow.reviewedFindings.filter((reviewedFinding) => reviewedFinding?.disposition === 'ACTIONABLE')) {
      for (const lane of lanesFromReviewerTags(finding.reviewer, reviewLanes)) laneRowFor(ledgerRow.at.slice(0, 7), lane).actionable += 1
    }
  }
  return rowsByMonth
}

function printTable(table) {
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => String(row[column]).length)))
  for (const row of table) console.log(row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd())
}

function reportLanes() {
  const table = [['Month', 'Lane', 'Runs', 'Tokens', 'Minutes', ...severities, 'Actionable']]
  const rowsByMonth = laneRowsByMonth()
  for (const month of [...rowsByMonth.keys()].sort()) {
    for (const [lane, laneRow] of [...rowsByMonth.get(month)].sort(([left], [right]) => left.localeCompare(right))) {
      table.push([month, lane, laneRow.runs, laneRow.tokens, Math.round(laneRow.durationMs / 60000), ...severities.map((severity) => laneRow.findingsBySeverity[severity]), laneRow.actionable])
    }
  }
  printTable(table)
}

const escapeWindowSeconds = 14 * 24 * 60 * 60

function runGit(repoPath, gitArguments) {
  const pinnedConfig = ['-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.noprefix=false']
  return execFileSync('git', ['-C', repoPath, ...pinnedConfig, ...gitArguments], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function isRefPresent(repoPath, ref) {
  return spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' }).status === 0
}

function mainlineOf(repoPath) {
  const mainlineRef = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master'].find((ref) => isRefPresent(repoPath, ref))
  if (mainlineRef) return mainlineRef
  console.error(`no mainline in ${repoPath}: none of origin/HEAD, main, or master resolves`)
  process.exit(2)
}

function mainlineCommits(repoPath, mainlineRef) {
  const log = runGit(repoPath, ['log', '--no-merges', '--format=%H%x1f%ct%x1f%s%x1f%(trailers:key=Confidence,valueonly,separator=%x2C)%x1e', mainlineRef, '--'])
  return log.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, committedAt, subject, confidence] = record.split('\x1f')
    return { sha, committedAtSeconds: Number(committedAt), subject, isGated: Boolean(confidence?.trim()) }
  })
}

function blameablePathsOfFix(repoPath, fixSha) {
  const rawFields = runGit(repoPath, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', `${fixSha}^`, fixSha]).split('\0')
  const paths = []
  for (let index = 0; index + 1 < rawFields.length; index += 2) {
    const [oldMode] = rawFields[index].replace(/^:/, '').split(' ')
    if (oldMode === '000000' || oldMode === '160000') continue
    paths.push(rawFields[index + 1])
  }
  return paths
}

function removedRangesOf(repoPath, fixSha, path) {
  const diff = runGit(repoPath, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', `${fixSha}^`, fixSha, '--', path])
  return diff.split('\n').flatMap((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? /)
    const removedLineCount = hunk?.[2] === undefined ? 1 : Number(hunk[2])
    return hunk && removedLineCount > 0 ? [`${hunk[1]},+${removedLineCount}`] : []
  })
}

function originShasOfFix(repoPath, fix) {
  const sinceSeconds = fix.committedAtSeconds - escapeWindowSeconds
  const originShas = new Set()
  for (const path of blameablePathsOfFix(repoPath, fix.sha)) {
    const ranges = removedRangesOf(repoPath, fix.sha, path)
    if (ranges.length === 0) continue
    const rangeArguments = ranges.flatMap((range) => ['-L', range])
    const blame = runGit(repoPath, ['blame', '-w', '--porcelain', `--since=${sinceSeconds}`, ...rangeArguments, `${fix.sha}^`, '--', path])
    let headerSha = null
    for (const line of blame.split('\n')) {
      const header = line.match(/^([0-9a-f]{40}) \d+ \d+/)
      if (header) headerSha = header[1]
      if (line === 'boundary' && headerSha) originShas.add(`boundary:${headerSha}`)
      if (header) originShas.add(header[1])
    }
  }
  return [...originShas].filter((sha) => !sha.startsWith('boundary:') && !originShas.has(`boundary:${sha}`))
}

function reviewedCommitFinder(repoPath, mainlineRef) {
  const ledgerRows = readReviewLedger()
  const ledgerRowByCommit = new Map(ledgerRows.map((row) => [row.commit, row]))
  const ledgerRowByPatchId = new Map(ledgerRows.filter((row) => row.patchId).map((row) => [row.patchId, row]))
  let patchIdByCommit = null
  return (sha) => {
    if (ledgerRowByCommit.has(sha) || ledgerRowByPatchId.size === 0) return ledgerRowByCommit.get(sha)
    patchIdByCommit ??= mainlinePatchIds(repoPath, mainlineRef)
    return ledgerRowByPatchId.get(patchIdByCommit.get(sha))
  }
}

function mainlinePatchIds(repoPath, mainlineRef) {
  return new Git(repoPath).patchIdsByCommit([mainlineRef, '--'])
}

function escapeRowsByMonth(repoPath) {
  const mainlineRef = mainlineOf(repoPath)
  const commits = mainlineCommits(repoPath, mainlineRef)
  const commitBySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const escapedShas = new Set()
  for (const fix of commits.filter((commit) => /^fix(\(.*\))?!?:/.test(commit.subject))) {
    for (const originSha of originShasOfFix(repoPath, fix)) {
      const origin = commitBySha.get(originSha)
      if (!origin?.isGated || origin.sha === fix.sha) continue
      if (fix.committedAtSeconds - origin.committedAtSeconds > escapeWindowSeconds) continue
      escapedShas.add(origin.sha)
    }
  }
  const reviewedCommitOf = reviewedCommitFinder(repoPath, mainlineRef)
  const rowsByMonth = new Map()
  for (const commit of commits.filter((commit) => commit.isGated)) {
    const month = new Date(commit.committedAtSeconds * 1000).toISOString().slice(0, 7)
    if (!rowsByMonth.has(month)) rowsByMonth.set(month, { gated: 0, escaped: 0, escapedCountByLane: new Map() })
    const monthRow = rowsByMonth.get(month)
    monthRow.gated += 1
    if (!escapedShas.has(commit.sha)) continue
    monthRow.escaped += 1
    for (const lane of reviewedCommitOf(commit.sha)?.lanes ?? []) monthRow.escapedCountByLane.set(lane, (monthRow.escapedCountByLane.get(lane) ?? 0) + 1)
  }
  return rowsByMonth
}
function reportEscapes(repoPath) {
  const table = [['Month', 'Gated', 'Escaped', 'Escape rate', 'Escaped, reviewed by']]
  const rowsByMonth = escapeRowsByMonth(repoPath)
  for (const month of [...rowsByMonth.keys()].sort()) {
    const { gated, escaped, escapedCountByLane } = rowsByMonth.get(month)
    const escapedLanes = [...escapedCountByLane].map(([lane, count]) => `${lane} ${count}`).join(', ') || '-'
    table.push([month, gated, escaped, `${Math.round((escaped / gated) * 100)}%`, escapedLanes])
  }
  printTable(table)
}

const { values: options } = parseArgs({ options: { escapes: { type: 'boolean' }, repo: { type: 'string' } } })
if (options.escapes) {
  reportEscapes(resolve(options.repo ?? '.'))
  process.exit(0)
}
reportLanes()
