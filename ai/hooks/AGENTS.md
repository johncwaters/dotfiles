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
| `challenge-plan.mjs` | PreToolUse plan-challenge stamp gate | `test/challenge-plan.test.mjs` |
| `check-finding-scope.mjs` | PostToolUse finding anchors | `test/check-finding-scope.test.mjs` |
| `inject-routing.mjs` | SessionStart routing context | `test/inject-routing.test.mjs` |
| `load-agents-md.mjs` | SessionStart and PostToolUse(Read) injection of AGENTS.md files a CLAUDE.md shadows (Claude Code 2.1.287 loads AGENTS.md only when no CLAUDE.md sits between it and the repo root) | `test/load-agents-md.test.mjs` |
| `report-parked-branches.mjs` | SessionStart commit-ledger report | `test/report-parked-branches.test.mjs` |
| `retro-reminder.mjs` | SessionEnd incident count and nudge; SessionStart unreviewed-retro report | `test/retro-reminder.test.mjs` |
| `block-comments.mjs`, `comment-scanner.mjs` | PreToolUse comment-growth guard | `test/block-comments.test.mjs` |
| `hook-io.mjs` | Shared payload and decision protocol | Guard tests above |

`block-comments.mjs` belongs to Glimmervoid's per-session hooks in
`glimmervoid/config.example.json`, not `ai/settings.base.json`, so its scope stays local
to Glimmervoid sessions. Profile-only hooks and their evidence belong in
`profiles/<name>/hooks/`, with wiring in that profile's `settings.overlay.json` and
`codex-hooks.json`, so shared hooks cannot import another profile's policy.
`ai/test.sh` pins the installed paths; shared event wiring lives in `ai/settings.base.json`.

## Validator constraints

- Keep the decision in PreToolUse: PostToolUse cannot undo bytes already written.
- Keep the source ASCII and control-character detection numeric. Previous edits
  introduced literal NUL/control bytes while attempting regex escapes.
- Keep the validator synchronous and dependency-free with Node built-ins and
  `hook-io.mjs`; it runs on every write.
- Use `biome format` and `ruff format` for decisions, never lint/type checks:
  valid code must not be blocked for style or type errors.
- Biome suppresses located diagnostics on stdin. Harvest with
  `biome check --reporter=json` only after denial; accept only `category === "parse"`
  to exclude lint messages. Harvest failure must preserve denial with a generic
  reason, never allow the write.
- A `.js` file under a `workflows` directory that opens with `export const meta =` runs
  as an async function body, so top-level `return` is legal there. Only after the plain
  parse fails, compile that body with the AsyncFunction constructor without calling it: a
  textual wrapper can be closed early by the body's own brackets. The retry can turn a
  denial into an allow and never the reverse.
- Preserve real basenames for stdin and harvest files so Biome recognizes JSONC
  names such as `tsconfig.json`. A synthetic `f.json` rejects valid config.
- Preserve both explicit Edit `content` and old/new-string replay; both payload
  shapes are supported. `test/validate-file.test.mjs` pins them.
- Deny instruction-file growth, never size alone, so oversized files can shrink.
  Cap repo roots, `~/.claude`, and its linked instruction source; nested copies
  load on demand and must remain uncapped.
- Discover Biome through deterministic native-package paths with the Node shim
  fallback; never spawn npm or glob on every write. `BIOME_BIN` overrides discovery.
- Prefer `python3` on PATH before bare `python`; distributions without `python`
  would silently lose the Ruff gate. `PYTHON_BIN` overrides discovery.
- Preserve Flutter's `cache/dart-sdk/bin/dart` lookup and `DART_BIN` override.
  Only Dart exit 65 is a parse denial; other engine failures must allow.

## Verification

`bash ai/test.sh` runs the hook and commit suites. After validator changes, also
exercise available real parsers with valid and invalid JSON, TypeScript, and
Python, plus a commented `tsconfig.json`. Denials must include a specific cause
and location (`line N, column M`); type errors must pass. For
`const x: number = ;`, verify line 1, column 19 and `Expected an expression`.
