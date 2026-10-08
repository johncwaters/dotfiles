# Work hook invariants

`confine-cloudflare.mjs` fails closed for Cloudflare calls: the carbon unit limits Cloudflare
work to the backchannel repo, and the plugin's OAuth grant spans the whole account. The permit
is the git common dir of `~/Projects/backchannel`, since a session can forge an origin URL.
Matching the generic `cf` name is best-effort (shell expansion is undecidable); the permit is the boundary.
`confine-backchannels.mjs` keeps backchannels, an internal PostHog tool, out of personal projects: it
permits only PostHog-origin repos, the backchannel clone, and non-repo workspace folders whose child repos are all work repos, denies elsewhere, and fails closed for backchannels calls.

Codex startup must pass confinement before loading backchannels context, because its skill
instructions otherwise register in personal repos; `test/confine-backchannels.test.mjs` pins this.

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `confine-cloudflare.mjs` | PreToolUse Cloudflare tool, skill, and CLI confinement to the backchannel repo (work overlay) | `test/confine-cloudflare.test.mjs` |
| `confine-backchannels.mjs` | PreToolUse backchannels tool and skill denial plus SessionStart opt-out outside work repos (work overlay) | `test/confine-backchannels.test.mjs` |
| `gate-posthog-exec-write.mjs` | PreToolUse ask on sensitive PostHog MCP writes (work overlay); port of the PostHog plugin's `gate-exec-write.sh`, sync its write verbs on plugin updates | `test/gate-posthog-exec-write.test.mjs` |
