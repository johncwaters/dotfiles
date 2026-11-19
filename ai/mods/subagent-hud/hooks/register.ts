import type { AgentInfo, Register } from 'claude-code'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'

const SEPARATOR = ' · '

function shortModelName(modelId: string | undefined) {
  if (modelId === undefined) return null
  return modelId.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '')
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function formatTokens(tokenCount: number) {
  if (tokenCount < 1000) return String(tokenCount)
  if (tokenCount < 1000000) return `${(tokenCount / 1000).toFixed(1)}k`
  return `${(tokenCount / 1000000).toFixed(2)}M`
}

function contextColor(usedPercentage: number) {
  if (usedPercentage >= 85) return RED
  if (usedPercentage >= 70) return YELLOW
  return GREEN
}

function contextSegment(agent: AgentInfo) {
  const tokens = formatTokens(agent.tokenCount)
  if (agent.contextWindowSize === undefined || agent.contextWindowSize <= 0) return `ctx ${tokens}`
  const usedPercentage = Math.round((agent.tokenCount / agent.contextWindowSize) * 100)
  return `ctx ${tokens} ${contextColor(usedPercentage)}${usedPercentage}%${RESET}${DIM}`
}

function effortSegment(effort: AgentInfo['effort']) {
  if (typeof effort === 'string') return effort
  if (typeof effort === 'number') return `${formatTokens(effort)} think`
  return null
}

function renderAgentRow(agent: AgentInfo, nowMs: number) {
  const details = [
    shortModelName(agent.model),
    effortSegment(agent.effort),
    formatElapsed(nowMs - agent.startTime),
    contextSegment(agent),
  ].filter(segment => segment !== null && segment !== '')
  const heading = agent.name || agent.description || agent.id
  return `${BOLD}${heading}${RESET}  ${DIM}${details.join(SEPARATOR)}${RESET}`
}

export const register: Register = on => {
  on('ui.render', { component: 'AgentRow' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, body: renderAgentRow(e.props, Date.now()) } }),
  )
}
