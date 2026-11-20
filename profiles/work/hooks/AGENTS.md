# Work hooks

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `require-worktree.mjs` | PreToolUse deny on a Claude or agy edit in a repo's main checkout, or in a worktree other than the session's (work overlay, `agy-hooks.json`) | `test/require-worktree.test.mjs` |
| `gate-posthog-exec-write.mjs` | PreToolUse ask on sensitive PostHog MCP writes (work overlay); port of the PostHog plugin's `gate-exec-write.sh`, sync its write verbs on plugin updates | `test/gate-posthog-exec-write.test.mjs` |
