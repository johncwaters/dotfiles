# Hook invariants

These hooks affect every Claude Code session. Preserve fail-open behavior: malformed
payloads, unreadable files, and unavailable decision engines must allow silently.
A guard failure must never wedge a session; catches that allow are intentional.
Fork spawns stay exempt from model pinning because the harness ignores their
model argument; `test/enforce-spawn-model.test.mjs` pins the exception.
`gate-codex-dispatch.mjs` fails closed for `codex-dispatcher` calls only: that agent skips
CLAUDE.md, so this hook is its sole confinement to a read-only Codex relay.

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `validate-file.mjs` | PreToolUse syntax, character, and instruction-size guard | `test/validate-file.test.mjs` |
| `validate-spec.mjs` | PreToolUse design graph contract guard | `test/validate-spec.test.mjs` |
| `enforce-spawn-model.mjs` | PreToolUse model and scope guard | `test/enforce-spawn-model.test.mjs` |
| `gate-codex-dispatch.mjs` | PreToolUse subagent Codex ban; read-only relay for `codex-dispatcher` | `test/gate-codex-dispatch.test.mjs` |
| `guard-workflow.mjs` | PreToolUse attended main-loop gate: raw git commit/push outside /commit, first repo edit without /spec | `test/guard-workflow.test.mjs` |
| `session-transcript.mjs` | Shared transcript event stream for the workflow gates | `test/guard-workflow.test.mjs` |
| `check-finding-scope.mjs` | PostToolUse finding anchors | `test/check-finding-scope.test.mjs` |
| `inject-routing.mjs` | SessionStart routing context | `test/inject-routing.test.mjs` |
| `load-agents-md.mjs` | SessionStart and PostToolUse(Read) injection of AGENTS.md files a CLAUDE.md shadows (Claude Code 2.1.287 loads AGENTS.md only when no CLAUDE.md sits between it and the repo root) | `test/load-agents-md.test.mjs` |
| `report-parked-branches.mjs` | SessionStart commit-ledger report | `test/report-parked-branches.test.mjs` |
| `retro-reminder.mjs` | SessionEnd incident count and nudge; SessionStart unreviewed-retro report | `test/retro-reminder.test.mjs` |
| `block-comments.mjs`, `comment-scanner.mjs` | PreToolUse comment-growth guard | `test/block-comments.test.mjs` |
| `edit-replay.mjs` | Shared Edit and MultiEdit reconstruction | `test/validate-file.test.mjs`, `test/block-comments.test.mjs` |
| `hook-io.mjs` | Shared payload and decision protocol | Guard tests above |

`block-comments.mjs` belongs to Glimmervoid's per-session hooks in
`glimmervoid/config.example.json`, not `ai/settings.base.json`, so its scope stays local
to Glimmervoid sessions. Profile-only hooks and their evidence belong in
`profiles/<name>/hooks/`, with wiring in that profile's `settings.overlay.json` and
`codex-hooks.json`, so shared hooks cannot import another profile's policy.
`ai/test.sh` pins the installed paths; shared event wiring lives in `ai/settings.base.json`.

## Validator invariants

- Keep decisions in PreToolUse because PostToolUse cannot undo written bytes.
- Keep source ASCII and character detection numeric; earlier edits introduced literal NUL/control bytes.
- Keep validation synchronous and limited to Node built-ins and shared hook helpers because it runs on every write.
- Gate syntax with formatters, never lint or type checks, so valid code remains writable; diagnostic harvesting must never overturn a denial.
- Compile workflow bodies without calling them: top-level returns are legal there, and textual wrappers can be escaped by the body's brackets.
- Preserve real basenames for parser input because names such as `tsconfig.json` select JSONC parsing.
- Deny instruction-file growth rather than size so oversized files can shrink; nested instructions load on demand and stay uncapped.

`test/validate-file.test.mjs` pins parser discovery and payload contracts. After validator changes,
exercise available real parsers with valid and invalid JSON, TypeScript, Python, and commented
`tsconfig.json` so unavailable engines cannot hide a broken gate.
