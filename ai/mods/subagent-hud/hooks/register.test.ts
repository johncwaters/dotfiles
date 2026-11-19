import type { AgentInfo, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g

function localAgent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'a3a1072656b09d7d3',
    description: 'Fix review round 1',
    type: 'general-purpose',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'Checking property-filter history in vercel.json',
    startTime: Date.now() - 128_000,
    cwd: '/repo',
    model: 'claude-opus-5-5[1m]',
    contextWindowSize: 1_000_000,
    tokenCount: 101_486,
    tokenSamples: [],
    hasRow: true,
    ...overrides,
  }
}

function captureBodies(on: On) {
  const bodies: string[] = []
  on('ui.render', { component: 'AgentRow' }, (_, e, next) => {
    bodies.push((e.props.body ?? '').replace(ANSI_ESCAPES, ''))
    return next(e)
  })
  return bodies
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: an unnamed agent is headed by its task title with model, elapsed time and context use`, async ($, on) => {
    const bodies = captureBodies(on)
    const ui = await $.ui.mount({
      plugin: 'subagent-hud',
      surface,
      component: 'AgentRow',
      props: { ...localAgent({}), rowIds: ['a3a1072656b09d7d3'], isHidden: false },
    })

    expect(bodies.at(-1)).toBe('Fix review round 1  opus-5-5 · 2m 08s · ctx 101.5k 10%')
    await ui.unmount()
  })

  test(`${surface}: a named agent is headed by its name and shows its effort`, async ($, on) => {
    const bodies = captureBodies(on)
    const ui = await $.ui.mount({
      plugin: 'subagent-hud',
      surface,
      component: 'AgentRow',
      props: { ...localAgent({ name: 'dotfiles-dispatch', effort: 'high' }), rowIds: ['a3a1072656b09d7d3'], isHidden: false },
    })

    expect(bodies.at(-1)?.startsWith('dotfiles-dispatch  opus-5-5 · high · ')).toBe(true)
    await ui.unmount()
  })
}
