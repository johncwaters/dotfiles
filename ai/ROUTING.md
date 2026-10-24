<routing>
Main session loop only; subagents skip per `<scope>`. Single source of truth for model selection and delegation. A profile `<routing>` section wins and may amend this by reference.

Rows verified live 2026-09-25 on codex-cli 0.155.1 and Claude Code 2.1.282; `gpt-6.1-sol` 2026-09-29 on codex-cli 0.159.0; `sonnet` and `fable` 2026-09-28 on 2.1.284; `haiku` 2026-10-07 on 2.1.293. Re-verify a row (run its Access command, update this stamp) when its id errors, a newer tier ships, a plan or price changes, or the stamp is over 90 days old.

Int and speed 1 (low) to 10 (high). Cost is list API price, USD per 1M tokens in / out; Codex is flat-rate here (ChatGPT Pro Lite), so its price is quota weight, not a bill; a plan change reopens rule 1.

| Model | Int | Speed | $/1M in / out | Access | Use for |
|---|---|---|---|---|---|
| `opus` (claude-opus-5-5) | 9 | 6 | 4 / 20 | default session model; Agent `model=opus` | Main loop; default Claude tier (rule 2) |
| `fable` (claude-fable-5-1) | 10 | 5 | 10 / 50 | Agent `model=fable` | Spawned slices where top judgment beats cost (security review pinned here) |
| `sonnet` (claude-sonnet-5-5) | 8 | 8 | 2 / 10 | Agent `model=sonnet`; `settings.base.json` pins the alias via `ANTHROPIC_DEFAULT_SONNET_MODEL`, since Claude Code 2.1.284 still resolves it to claude-sonnet-5 | Rule 2 downgrade only |
| `haiku` (claude-haiku-5-5) | 5 | 10 | 0.10 / 0.50 (0.50 / 2.50 past 100K-token prompts) | Agent `model=haiku`; `settings.base.json` pins the alias via `ANTHROPIC_DEFAULT_HAIKU_MODEL`, so a Claude Code alias change cannot move the relay off the evaluated model | Rule 2 floor; `codex-dispatcher` relay, where a 2026-10-07 eval tied `sonnet` on router success, Codex failure, and verbatim relay |
| `gpt-6-astra` (Codex, top) | 10 | 4 | 10 / 50 | `codex exec ... -m gpt-6-astra -c model_reasoning_effort="high"` (codex-cli 0.153.1+; older CLIs reject the id, so upgrade with `npm install -g @openai/codex@latest`) | Rule 1 hardest and long-context slices, where it clearly beats `sol`. Default effort is `medium`, so pass `high` (`xhigh`/`max`/`ultra` for the hardest; `ultra` delegates on its own) |
| `gpt-6.1-sol` (Codex, default) | 8 | 6 | 2 / 10 | `codex exec ... -m gpt-6.1-sol` (codex-cli 0.159.0+; 0.156.1 rejects the id on a ChatGPT account) | Rule 0 PC control; rule 1 default executor. Codex default effort is `low`, so pass `-c model_reasoning_effort="medium"` for ordinary coding and `high` for debugging, cross-cutting refactors, architecture, and second opinions |
| `gpt-6-luna` (Codex, fast) | 5 | 9 | 0.10 / 0.50 | `codex exec ... -m gpt-6-luna` | Rule 1 trivial mechanical slices |

The table is a map, not a gate: an unlisted model is routable under rule 1b when you name why and its id verifiably works.

External dispatch: prompt in a temp file. Codex: `codex exec --dangerously-bypass-approvals-and-sandbox -m <model> [-c model_reasoning_effort="<level>"] < <file>`; only the three Codex ids above work on a ChatGPT account. Dispatch as one Bash `run_in_background` call, never a Monitor, so it costs one wake-up. Codex does not see this conversation; judge its output yourself. Subagents may not dispatch (`hooks/gate-codex-dispatch.mjs`); a workflow reaches Codex only through the `codex-dispatcher` agent, whose one admitted command is `codex exec -c '<qa_review profile>' ...`: read-only, no network, credential paths denied, so untrusted review input cannot write, exfiltrate, or read secrets.

First ask whether a model is needed at all: grep, sed, scripts, SQL, formatters, linters, type checkers, and `git log` are free and cannot hallucinate. Spend a model on judgment only.

Decision order for any delegated task:
0. Local PC control (OS settings, services, processes, scheduled tasks, installs, power, devices, desktop automation): Codex `gpt-6.1-sol`, the only external path for it. Verify the change took effect. Destructive or hard-to-reverse changes still need user confirmation first.
1. Codex first, it is flat-rate: `luna` for trivial mechanical work, `sol` for ordinary coding (default when unsure) and at `high`+ for debugging, cross-cutting refactors, architecture, and second opinions on risky diffs, `astra` at `high`+ for the hardest of those, for inputs large enough that `sol` loses the thread, or after `sol` fails. Only these stay on Claude: work needing Claude-side tools (MCP, subagents, live back-and-forth), security-sensitive code, final review of large or risky diffs, judgment gating a completion claim. Session context is not an exception: write what the slice needs into the prompt. A slice sent to a Claude subagent instead of Codex names the exception or rule (1a, 4) that keeps it there.
1a. Codex quota error (rate-limit or usage-cap, never a model or CLI error): `astra`, `sol`, `luna` share one allowance and `astra` drains it fastest, so no tier step frees quota. Rule 2 for the session, tell the user, retry Codex later.
1b. Structural fit outranks quota and price: when only one model can do the job (live web, a context window nothing else holds, multimodal input), route there and skip rules 1 and 2. Nothing fits: say so and propose the tool.
2. Work kept off Codex, or after 1a: `opus` by default, including anything of uncertain complexity. `sonnet` only for one-shot slices with simple checkable output where opus changes nothing; a cheaper tier that fails once costs more than one that one-shots. `haiku` only for one-shot short answers checkable at a glance (classify, label, extract a field) and pure relays that run one fixed command and return its output, never code, debugging, review, or a completion-gating judgment.
3. A concrete failure on a lower tier reruns one tier up (`luna`, `sol`, `astra`; `haiku`, `sonnet`, `opus`), never the same tier again, never a tier below these floors.
4. Read-only sweeps use `Explore`, not `general-purpose`. Every spawn pins `model`; `hooks/enforce-spawn-model.mjs` denies one without it. A Workflow script pins `model` on every `agent()` call, and `ai/test.sh` pins that.
5. Change a default only on eval evidence: the same tasks run through the competing routes with judged output. No eval covers the slice: write the task first, then reroute.

Delegation prompts: the target cannot see this conversation, so carry objective, definition of done, paths, prior decisions, constraints, an output contract that fits back into context, and boundaries. Agent prompts carry literal `Scope:`, `Out of scope:`, and `Definition of done:` lines or `hooks/enforce-spawn-model.mjs` denies them. Do not restate AGENTS.md rules Claude subagents and Codex already read (global plus repo copy).

Posture by session model:
- Opus (default): do Claude-side work in the main loop. Spawning Claude subagents to orchestrate did not pay: 2026-09/10 logs showed delegating sessions costing about 3x per edit with no drop in review findings, because the main loop's context, not the subagents, carries the spend. Codex is flat-rate, so still send it self-contained coding slices per rule 1; ask for a short receipt (files changed, checks run) and verify by running checks rather than rereading its diff into context. Spawn a Claude subagent only for independent slices worth running in parallel, broad read-only sweeps (`Explore`, rule 4), or digging whose transcript would bloat the main context more than its answer. Skills and workflows that spawn agents by their own instructions (`/committing`, `qa-swarm`, `plan-challenge`) run as written; this posture governs only discretionary spawns.
- Fable (opt-in): same posture as Opus; spend it where top judgment beats cost.
- Other: apply the decision order directly.
</routing>
