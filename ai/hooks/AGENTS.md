# Hook invariants

These hooks affect every Claude Code, Codex, and agy session. Preserve fail-open behavior: malformed
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
| `guard-workflow.mjs` | PreToolUse gate: for every agent, a foreground run-all.sh, package install, bootstrap, or `dot` converge without run_in_background, unless background tasks are disabled; main loop: raw git commit/push outside /landing and any `gh` call other than a known read before writing-in-voice in every session, pointing at the review gate first (quoted and literal heredoc text masked; a dry-run push and a `git -C <system-temp repo root> commit` pass only as a command of nothing but such literal calls); attended only: self-matching `pkill -f`, first repo edit without /specifying, a /specifying question, until its spec is archived, with no Upstream clause or change-at-the-source option, or whose change-at-the-source option is not first | `test/guard-workflow.test.mjs` |
| `require-commit-on-stop.mjs` | Stop hook: blocks once a turn ending with uncommitted session edits and no /landing, pointing at the review gate then /landing, unless a background launch has not reported back | `test/require-commit-on-stop.test.mjs` |
| `require-carbon-unit.mjs` | Stop hook: blocks once per turn, tracked by its own feedback in the transcript since `stop_hook_active` is shared by every Stop hook, a reply whose prose, outside code and quotes, says human, person, people, developer, engineer, or user, naming each word | `test/require-carbon-unit.test.mjs` |
| `engine-gate.mjs` | Stop hook that reviewing-prs registers from its frontmatter: blocks once a run that stops before launching qa-swarm or a lane agent | `test/engine-gate.test.mjs` |
| `session-transcript.mjs` | Shared transcript event stream for the workflow gates | `test/guard-workflow.test.mjs` |
| `check-finding-scope.mjs` | PostToolUse finding anchors | `test/check-finding-scope.test.mjs` |
| `load-agents-md.mjs` | SessionStart and PostToolUse(Read) injection of AGENTS.md files a CLAUDE.md shadows (Claude Code 2.1.287 loads AGENTS.md only when no CLAUDE.md sits between it and the repo root) | `test/load-agents-md.test.mjs` |
| `report-parked-branches.mjs` | SessionStart commit-ledger report | `test/report-parked-branches.test.mjs` |
| `retro-reminder.mjs` | SessionEnd incident count and nudge; SessionStart unreviewed-retro report | `test/retro-reminder.test.mjs` |
| `block-comments.mjs` | PreToolUse comment-growth guard | `test/block-comments.test.mjs` |
| `block-else.mjs`, `block-use-effect.mjs`, `block-fixed-sleep.mjs`, `block-button-labels.mjs`, `edit-judge.mjs` | PreToolUse else-, useEffect-, test sleep-then-assert and stateful button-label growth guards; shared growth runner over `fileChangesOf` | `test/block-else.test.mjs`, `test/block-use-effect.test.mjs`, `test/block-fixed-sleep.test.mjs`, `test/block-button-labels.test.mjs` |
| `comment-scanner.mjs` | Shared comment, else, useEffect, fixed-sleep, and button-label scanners | `test/block-comments.test.mjs`, `test/block-button-labels.test.mjs`, `test/block-else.test.mjs`, `test/block-use-effect.test.mjs`, `test/block-fixed-sleep.test.mjs` |
| `edit-replay.mjs` | Shared Edit and MultiEdit reconstruction | `test/validate-file.test.mjs`, `test/block-comments.test.mjs` |
| `hook-io.mjs` | Shared payload and decision protocol | Guard tests above |
| `agent-payload.mjs` | Maps Codex and agy payloads to Claude's tool names and inputs, and every file-changing call to `fileChangesOf`; a Codex patch is applied by Codex's own matching rules, since any other placement judges a file Codex never writes. The agent comes from the wiring's `--agent=` argument, never the payload shape, which a harness release can change | `test/block-else.test.mjs`, `test/validate-spec.test.mjs`, `test/validate-file.test.mjs` |
| `repo-ownership.mjs` | Owned or foreign for a path, from the profile's `owned-repos.txt`; unknown is foreign | `test/repo-ownership.test.mjs` |
| `ratchet.mjs` | Fails a committed `.agents/ratchet.json` on growth and lowers it on a fall; `init` only in owned code; run by `/gating-reviews` | `test/ratchet.test.mjs` |

`block-comments.mjs` belongs to Glimmervoid's per-session hooks in
`glimmervoid/settings.json`, not `ai/settings.base.json`, so its scope stays local
to Glimmervoid sessions. `block-else.mjs`, `block-use-effect.mjs`, `block-fixed-sleep.mjs`, and `block-button-labels.mjs` bind every agent, so they
are wired in `ai/settings.base.json` for every Claude, `ai/codex-hooks.base.json` for every Codex, and `ai/agy-hooks.base.json` for every agy. Profile-only hooks and their evidence belong in
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
