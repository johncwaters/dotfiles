<routing>
Main session loop only; subagents skip per `<scope>`. Single source of truth for model selection, subagent delegation, and external offload. A profile CLAUDE.md defining its own `<routing>` wins: it may replace this section or amend it by reference.

Rows verified live 2026-09-05 on codex-cli 0.153.4. Re-verify a row (run its Access command once, update this stamp) when its id errors, a newer tier ships, a plan changes, or the stamp is over 90 days old.

Intelligence and speed 1 (low) to 10 (high); cost 1 (cheap) to 10 (expensive). Codex and Grok are flat-rate (ChatGPT Pro Lite, Grok upgraded), so their cost is quota pressure; a plan change invalidates those cells.

| Model | Int | Speed | Cost | Access | Use for |
|---|---|---|---|---|---|
| `fable` (claude-fable-5-1) | 10 | 7 | 10 | session model; Agent `model=fable` | Main loop; spawned slices where top judgment beats cost (security review pinned here) |
| `opus` (claude-opus-5) | 8 | 4 | 8 | Agent `model=opus` | Default Claude tier (rule 2) |
| `sonnet` (claude-sonnet-5) | 6 | 6 | 5 | Agent `model=sonnet` | Rule 2 downgrade only |
| `haiku` (claude-haiku-4-5) | 3 | 10 | 2 | Agent `model=haiku` | Rule 2 floor only |
| `gpt-6-astra` (Codex, top) | 9 | 3 | 5 | `codex exec ... -m gpt-6-astra -c model_reasoning_effort="high"` (codex-cli 0.153.1+; older CLIs reject the id, so upgrade with `npm install -g @openai/codex@latest`) | Rule 1 hardest slices. Default effort is `medium`, so pass `high` (`xhigh`/`max`/`ultra` for the hardest) |
| `gpt-5.6-sol` (Codex, frontier) | 8 | 4 | 3 | `codex exec ... -m gpt-5.6-sol -c model_reasoning_effort="high"` | Rule 1 hard slices. Default effort is `low`, so always pass `high` (`xhigh`/`max`/`ultra` for the hardest) |
| `gpt-5.6-terra` (Codex, balanced) | 6 | 6 | 2 | `codex exec ... -m gpt-5.6-terra` | Rule 0 PC control; rule 1 default executor |
| `gpt-5.6-luna` (Codex, fast) | 4 | 9 | 1 | `codex exec ... -m gpt-5.6-luna` | Rule 1 trivial mechanical slices |
| Grok (`grok-4.6`; `grok models` lists the rest) | 6 | 7 | 2 | `grok --prompt-file <file> --always-approve` | Rule 1b; needs `XAI_API_KEY` or `grok login --device-auth` (token lasts 7 days) |

The table is a map, not a gate: an unlisted model is routable under rule 1c when you name why and its id verifiably works.

External dispatch: write the full prompt to a temp file. Codex: `codex exec --dangerously-bypass-approvals-and-sandbox -m <model> [-c model_reasoning_effort="<level>"] < <file>`; only the four Codex ids above work on a ChatGPT account. Grok: `grok --prompt-file <file> --always-approve` (`-m <id>` only for a listed model). A grok "You are not authenticated" reply means the token lapsed: ask the user to run `! grok login --device-auth`, do not retry. Neither sees this conversation; judge the final stdout message yourself before treating it as done.

First ask whether this needs a model at all: grep, sed, a script, SQL, a formatter, linter, type checker, or `git log` is free, deterministic, and cannot hallucinate. Spend a model on judgment only; push mechanical work into commands the model runs.

Decision order for any delegated task:
0. Local PC control (OS settings, services, processes, scheduled tasks, installs, power, devices, desktop automation): Codex `gpt-5.6-terra`, the only external path for it. Verify the change took effect. Destructive or hard-to-reverse changes still need user confirmation first.
1. Codex first: flat-rate and already paid, so exhaust it before metered Claude. Tier by slice difficulty: `luna` trivial mechanical (formulaic single-file edits, renames, lookups, scripted sweeps); `terra` ordinary coding (default when unsure); `sol` at `high`+ for debugging, cross-cutting refactors, architecture-shaped work, second opinions on risky diffs; `astra` at `high`+ only for the hardest of those or after `sol` fails. Only these stay on Claude regardless of quota: work needing Claude-side tools (MCP, subagents, session context, live back-and-forth), security-sensitive code, final review of large or risky diffs, judgment gating a completion claim.
1a. Codex quota exhausted (rate-limit or usage-cap error, never a model or CLI error): step DOWN one Codex tier (`astra` to `sol` to `terra` to `luna`, separate pools). When `luna` also refuses, use rule 2 for the session, tell the user, retry Codex later.
1b. Grok by default for research, current events, X lookups; an independent non-OpenAI, non-Anthropic opinion (tie-breaker, or third check when Codex and Claude agree); a second external executor when Codex is saturated.
1c. Structural fit outranks quota and price: when exactly one model can do the job (live web and X, a context window no other holds, multimodal input), route there and skip rules 1 and 2. Nothing fits: say so and propose the tool; never fake it with a model that cannot see the input.
2. Work kept off Codex, or after a 1a fallback: `opus` by default, including anything of uncertain complexity. `sonnet` only for one-shot slices with simple checkable output where opus changes nothing: cost is price times turns-to-done, and a cheaper tier that fails once costs more than one that one-shots. `haiku` only for one-shot jobs whose whole output is a short answer checkable at a glance (classify, label, extract a field); never code edits, debugging, review, or a completion-gating judgment.
3. A concrete failure on a lower tier reruns one tier up (`luna` to `terra` to `sol` to `astra`; `haiku` to `sonnet` to `opus`), never another pass on the same tier. Never downroute below these floors to balance a spread.
4. Read-only searches and sweeps use `Explore`, not `general-purpose`. Every spawn pins `model` explicitly; `hooks/enforce-spawn-model.mjs` denies an omitted one.
5. Change a default only on `evals/` evidence (same tasks, competing routes, judged output). No eval covers the slice: write the task first, then reroute.

Delegation prompts (every spawn and dispatch): the target cannot see this conversation, so carry objective, definition of done, unseen context (paths, prior decisions, constraints, the why), an output contract that fits back into context, tool guidance, and boundaries (scope limits, don't-touch zones, when to stop and report). Agent prompts include literal `Scope:`, `Out of scope:`, and `Definition of done:` lines or `hooks/enforce-spawn-model.mjs` denies them. Never restate AGENTS.md rules Claude subagents and Codex already read (global plus repo copy); Grok reads only the repo copy, so a Grok dispatch carries any global rule it must follow.

Posture by session model:
- Opus: decompose into bounded slices, dispatch independent ones concurrently, keep planning, synthesis, and verification in the main loop. No agent for a one-line edit, a single command, or live back-and-forth.
- Fable: orchestrator, never worker. Anything over ~3 tool calls, more than one file, or output the user will not read verbatim gets dispatched per the decision order. When torn between doing and delegating, delegate; judge every result yourself before relaying it. Direct work only for single commands, trivial one-file edits, and answers already in context.
- Any other model: apply the decision order directly.
</routing>
