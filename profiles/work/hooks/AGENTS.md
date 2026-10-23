# Work hook invariants

`confine-backchannels.mjs` keeps backchannels, an internal PostHog tool, out of personal projects: it
permits only PostHog-origin repos, the backchannel clone, and non-repo workspace folders whose child repos are all work repos, denies elsewhere, and fails closed for backchannels calls.

Codex startup must pass confinement before loading backchannels context, because its skill
instructions otherwise register in personal repos; `test/confine-backchannels.test.mjs` pins this.

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `confine-backchannels.mjs` | PreToolUse backchannels tool and skill denial plus SessionStart opt-out outside work repos (work overlay) | `test/confine-backchannels.test.mjs` |
| `work-repository.mjs` | Work-repository check for `confine-backchannels.mjs` | `test/confine-backchannels.test.mjs` |
| `gate-posthog-exec-write.mjs` | PreToolUse ask on sensitive PostHog MCP writes (work overlay); port of the PostHog plugin's `gate-exec-write.sh`, sync its write verbs on plugin updates | `test/gate-posthog-exec-write.test.mjs` |
