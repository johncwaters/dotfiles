# Work hooks

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `gate-posthog-exec-write.mjs` | PreToolUse ask on sensitive PostHog MCP writes (work overlay); port of the PostHog plugin's `gate-exec-write.sh`, sync its write verbs on plugin updates | `test/gate-posthog-exec-write.test.mjs` |
