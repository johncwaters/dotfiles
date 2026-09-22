<routing>
Main session loop only; subagents skip per `<scope>`. Single source of truth for model selection and delegation. A profile CLAUDE.md `<routing>` section wins and may amend this by reference.

Rows verified live 2026-09-22 on codex-cli 0.155.1 and Claude Code 2.1.280. Re-verify a row (run its Access command, update this stamp) when its id errors, a newer tier ships, a plan or price changes, or the stamp is over 90 days old.

Int and speed 1 (low) to 10 (high). Cost is list API price, USD per 1M tokens in / out; Codex and Grok are flat-rate here (ChatGPT Pro Lite, Grok upgraded), so their price is quota weight, not a bill; a plan change reopens rule 1.

| Model | Int | Speed | $/1M in / out | Access | Use for |
|---|---|---|---|---|---|
| `opus` (claude-opus-5-5) | 9 | 6 | 4 / 20 | default session model; Agent `model=opus` | Main loop orchestrator; default Claude tier (rule 2) |
| `fable` (claude-fable-5-1) | 10 | 7 | 10 / 50 | Agent `model=fable` | Spawned slices where top judgment beats cost (security review pinned here) |
| `sonnet` (claude-sonnet-5) | 6 | 6 | 2 / 10 | Agent `model=sonnet` | Rule 2 downgrade only |
| `haiku` (claude-haiku-4-5) | 3 | 10 | 1 / 5 | Agent `model=haiku` | Rule 2 floor only |
| `gpt-6-astra` (Codex, top) | 10 | 4 | 10 / 50 | `codex exec ... -m gpt-6-astra -c model_reasoning_effort="high"` (codex-cli 0.153.1+; older CLIs reject the id, so upgrade with `npm install -g @openai/codex@latest`) | Rule 1 hardest and long-context slices, where it clearly beats `sol`. Default effort is `medium`, so pass `high` (`xhigh`/`max`/`ultra` for the hardest; `ultra` delegates on its own) |
| `gpt-6-sol` (Codex, default) | 8 | 6 | 2 / 10 | `codex exec ... -m gpt-6-sol` | Rule 0 PC control; rule 1 default executor. Default effort is `medium`; pass `-c model_reasoning_effort="high"` for debugging, cross-cutting refactors, architecture, and second opinions |
| `gpt-6-luna` (Codex, fast) | 5 | 9 | 0.10 / 0.50 | `codex exec ... -m gpt-6-luna` | Rule 1 trivial mechanical slices |
| Grok (`grok-4.6`; `grok models` lists the rest) | 6 | 7 | 2 / 6 | `grok --prompt-file <file> --always-approve` | Rule 1b; needs `XAI_API_KEY` or `grok login --device-auth` (token lasts 7 days) |

The table is a map, not a gate: an unlisted model is routable under rule 1c when you name why and its id verifiably works.

External dispatch: prompt in a temp file. Codex: `codex exec --dangerously-bypass-approvals-and-sandbox -m <model> [-c model_reasoning_effort="<level>"] < <file>`; only the three Codex ids above work on a ChatGPT account. Grok: `grok --prompt-file <file> --always-approve` (`-m <id>` only for a listed model). Dispatch as one Bash `run_in_background` call, never a Monitor, so it costs one wake-up. A grok "You are not authenticated" reply means the token lapsed: ask the carbon unit to run `! grok login --device-auth`, do not retry. Neither sees this conversation; judge their output yourself.

First ask whether a model is needed at all: grep, sed, scripts, SQL, formatters, linters, type checkers, and `git log` are free and cannot hallucinate. Spend a model on judgment only.

Decision order for any delegated task:
0. Local PC control (OS settings, services, processes, scheduled tasks, installs, power, devices, desktop automation): Codex `gpt-6-sol`, the only external path for it. Verify the change took effect. Destructive or hard-to-reverse changes still need user confirmation first.
1. Codex first, it is flat-rate: `luna` for trivial mechanical work, `sol` for ordinary coding (default when unsure) and at `high`+ for debugging, cross-cutting refactors, architecture, and second opinions on risky diffs, `astra` at `high`+ for the hardest of those, for inputs large enough that `sol` loses the thread, or after `sol` fails. Only these stay on Claude: work needing Claude-side tools (MCP, subagents, session context, live back-and-forth), security-sensitive code, final review of large or risky diffs, judgment gating a completion claim.
1a. Codex quota error (rate-limit or usage-cap, never a model or CLI error): step down one Codex tier; `astra`, `sol`, `luna` have separate pools. `luna` also capped: rule 2 for the session, tell the user, retry Codex later. Capped tier reached by a rule 3 step-up: rule 2 for that task only.
1b. Grok by default for research, current events, X lookups; a non-OpenAI, non-Anthropic tie-breaker or third opinion; a second external executor when Codex is saturated.
1c. Structural fit outranks quota and price: when only one model can do the job (live web and X, a context window nothing else holds, multimodal input), route there and skip rules 1 and 2. Nothing fits: say so and propose the tool.
2. Work kept off Codex, or after 1a: `opus` by default, including anything of uncertain complexity. `sonnet` only for one-shot slices with simple checkable output where opus changes nothing; a cheaper tier that fails once costs more than one that one-shots. `haiku` only for one-shot short answers checkable at a glance (classify, label, extract a field), never code, debugging, review, or a completion-gating judgment.
3. A concrete failure on a lower tier reruns one tier up (`luna`, `sol`, `astra`; `haiku`, `sonnet`, `opus`), never the same tier again, never a tier below these floors.
4. Read-only sweeps use `Explore`, not `general-purpose`. Every spawn pins `model`; `hooks/enforce-spawn-model.mjs` denies one without it. A Workflow script pins `model` on every `agent()` call, and `ai/test.sh` pins that.
5. Change a default only on eval evidence: the same tasks run through the competing routes with judged output. No eval covers the slice: write the task first, then reroute.

Delegation prompts: the target cannot see this conversation, so carry objective, definition of done, paths, prior decisions, constraints, an output contract that fits back into context, and boundaries. Agent prompts carry literal `Scope:`, `Out of scope:`, and `Definition of done:` lines or `hooks/enforce-spawn-model.mjs` denies them. Do not restate AGENTS.md rules Claude subagents and Codex already read (global plus repo copy); Grok reads only the repo copy, so a Grok prompt carries any global rule it must follow.

Posture by session model:
- Opus (default): orchestrator. Decompose, dispatch independent slices concurrently per the decision order, keep planning, synthesis, and verification in the main loop; judge every result before relaying it. Direct work for single commands, one-file edits, answers already in context, and live back-and-forth.
- Fable (opt-in): same posture as Opus; spend it where top judgment beats cost.
- Other: apply the decision order directly.
</routing>
