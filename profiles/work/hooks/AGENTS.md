# Work hook invariants

`confine-cloudflare.mjs` fails closed for Cloudflare calls: the plugin's OAuth grant spans the whole account, so it permits
only sessions inside a work repository (`work-repository.mjs`: PostHog origin, the declared backchannels origin, or the
backchannel clone's git common dir). The carbon unit accepted that an origin URL can be forged.
Matching the generic `cf` name is best-effort (shell expansion is undecidable); the permit is the boundary.
`confine-backchannels.mjs` keeps backchannels, an internal PostHog tool, out of personal projects: it
permits only PostHog-origin repos, the backchannel clone, and non-repo workspace folders whose child repos are all work repos, denies elsewhere, and fails closed for backchannels calls.

Codex startup must pass confinement before loading backchannels context, because its skill
instructions otherwise register in personal repos; `test/confine-backchannels.test.mjs` pins this.

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `confine-cloudflare.mjs` | PreToolUse Cloudflare tool, skill, and CLI confinement to work repositories (work overlay) | `test/confine-cloudflare.test.mjs` |
| `confine-backchannels.mjs` | PreToolUse backchannels tool and skill denial plus SessionStart opt-out outside work repos (work overlay) | `test/confine-backchannels.test.mjs` |
| `work-repository.mjs` | Shared work-repository check for both confine hooks | `test/confine-cloudflare.test.mjs`, `test/confine-backchannels.test.mjs` |
| `gate-posthog-exec-write.mjs` | PreToolUse ask on sensitive PostHog MCP writes (work overlay); port of the PostHog plugin's `gate-exec-write.sh`, sync its write verbs on plugin updates | `test/gate-posthog-exec-write.test.mjs` |
