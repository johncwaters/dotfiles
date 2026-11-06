# Hook invariants

These hooks affect every Claude Code session. Preserve fail-open behavior: malformed
payloads, unreadable files, and unavailable decision engines must allow silently.
A guard failure must never wedge a session; catches that allow are intentional.
Fork spawns stay exempt from model pinning because the harness ignores their
model argument; `test/enforce-spawn-model.test.mjs` pins the exception.

## Map

| Script | Role | Evidence |
|--------|------|----------|
| `validate-file.mjs` | PreToolUse syntax, character, instruction-size, and skill-structure guard | `test/validate-file.test.mjs` |
| `skill-lint.mjs` | Skill structure rules, shared by the guard and its CLI over every skill | `test/validate-file.test.mjs` |
| `validate-spec.mjs` | PreToolUse design graph contract guard | `test/validate-spec.test.mjs` |
| `enforce-spawn-model.mjs` | PreToolUse model and scope guard | `test/enforce-spawn-model.test.mjs` |
| `guard-workflow.mjs` | PreToolUse main-loop gate: raw git commit/push outside /landing in every session, pointing at the review gate first (quoted and literal heredoc text masked); a defect question with no evidenced `Cause:` line in every session; attended only: self-matching `pkill -f`, first repo edit without /specifying | `test/guard-workflow.test.mjs` |
| `require-commit-on-stop.mjs` | Stop hook: blocks once a turn ending with uncommitted session edits and no /landing, pointing at the review gate then /landing, unless a background launch has not reported back | `test/require-commit-on-stop.test.mjs` |
| `session-transcript.mjs` | Shared transcript event stream for the workflow gates | `test/guard-workflow.test.mjs` |
| `check-finding-scope.mjs` | PostToolUse finding anchors | `test/check-finding-scope.test.mjs` |
| `load-agents-md.mjs` | SessionStart and PostToolUse(Read) injection of AGENTS.md files a CLAUDE.md shadows (Claude Code 2.1.287 loads AGENTS.md only when no CLAUDE.md sits between it and the repo root) | `test/load-agents-md.test.mjs` |
| `report-parked-branches.mjs` | SessionStart commit-ledger report | `test/report-parked-branches.test.mjs` |
| `retro-reminder.mjs` | SessionEnd incident count and nudge; SessionStart unreviewed-retro report | `test/retro-reminder.test.mjs` |
| `block-comments.mjs` | PreToolUse comment-growth guard | `test/block-comments.test.mjs` |
| `block-else.mjs`, `edit-judge.mjs` | PreToolUse else-growth guard; shared Write/Edit/MultiEdit growth judge | `test/block-else.test.mjs` |
| `comment-scanner.mjs` | Shared comment and else scanners with string tracking | `test/block-comments.test.mjs`, `test/block-else.test.mjs` |
| `edit-replay.mjs` | Shared Edit and MultiEdit reconstruction | `test/validate-file.test.mjs`, `test/block-comments.test.mjs` |
| `hook-io.mjs` | Shared payload and decision protocol | Guard tests above |

`block-comments.mjs` belongs to Glimmervoid's per-session hooks in
`glimmervoid/config.example.json`, not `ai/settings.base.json`, so its scope stays local
to Glimmervoid sessions. `block-else.mjs` is wired the same way for Claude and in
`ai/codex-hooks.base.json` for every Codex. Profile-only hooks and their evidence belong in
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
- Deny only skill writes that add lint violations, so unmigrated skills stay editable one fix at a time.

`test/validate-file.test.mjs` pins parser discovery and payload contracts. After validator changes,
exercise available real parsers with valid and invalid JSON, TypeScript, Python, and commented
`tsconfig.json` so unavailable engines cannot hide a broken gate.
