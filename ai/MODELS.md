Rows verified live 2026-09-25 on Claude Code 2.1.282; `sonnet` and `fable` 2026-09-28 on 2.1.284; `haiku` 2026-10-07 on 2.1.293. Re-verify a row (run its Access command, update this stamp) when its id errors, a newer tier ships, a plan or price changes, or the stamp is over 90 days old.

Int and speed 1 (low) to 10 (high). Cost is list API price, USD per 1M tokens in / out.

| Model | Int | Speed | $/1M in / out | Access | Use for |
|---|---|---|---|---|---|
| `opus` (claude-opus-5-5) | 9 | 6 | 4 / 20 | default session model; Agent `model=opus` | Main loop; default Claude tier (rule 2) |
| `fable` (claude-fable-5-1) | 10 | 5 | 10 / 50 | Agent `model=fable` | Spawned slices where top judgment beats cost (security review pinned here) |
| `sonnet` (claude-sonnet-5-5) | 8 | 8 | 2 / 10 | Agent `model=sonnet`; `settings.base.json` pins the alias via `ANTHROPIC_DEFAULT_SONNET_MODEL`, since Claude Code 2.1.284 still resolves it to claude-sonnet-5 | Rule 2 downgrade only |
| `haiku` (claude-haiku-5-5) | 5 | 10 | 0.10 / 0.50 (0.50 / 2.50 past 100K-token prompts) | Agent `model=haiku`; `settings.base.json` pins the alias via `ANTHROPIC_DEFAULT_HAIKU_MODEL`, so a Claude Code alias change cannot move it off the evaluated model | Rule 2 floor |

The table is a map, not a gate: an unlisted model is routable under rule 1b when you name why and its id verifiably works.

First ask whether a model is needed at all: grep, sed, scripts, SQL, formatters, linters, type checkers, and `git log` are free and cannot hallucinate. Spend a model on judgment only.

Choosing a model for a spawn:
1b. Structural fit outranks quota and price: when only one model can do the job (live web, a context window nothing else holds, multimodal input), route there and skip rule 2. Nothing fits: say so and propose the tool.
2. `opus` by default, including anything of uncertain complexity. `sonnet` only for one-shot slices with simple checkable output where opus changes nothing; a cheaper tier that fails once costs more than one that one-shots. `haiku` only for one-shot short answers checkable at a glance (classify, label, extract a field) and pure relays that run one fixed command and return its output, never code, debugging, review, or a completion-gating judgment.
3. A concrete failure on a lower tier reruns one tier up (`haiku`, `sonnet`, `opus`), never the same tier again, never a tier below these floors.
4. Read-only sweeps use `Explore`, not `general-purpose`. Every spawn pins `model`; `hooks/enforce-spawn-model.mjs` denies one without it. A Workflow script pins `model` on every `agent()` call, and `ai/test.sh` pins that.
5. Change a default only on eval evidence: the same tasks run through the competing routes with judged output. No eval covers the slice: write the task first, then reroute.

Delegation prompts: the target cannot see this conversation, so carry objective, definition of done, paths, prior decisions, constraints, an output contract that fits back into context, and boundaries. Agent prompts carry literal `Scope:`, `Out of scope:`, and `Definition of done:` lines or `hooks/enforce-spawn-model.mjs` denies them. Do not restate AGENTS.md rules Claude subagents already read (global plus repo copy).
