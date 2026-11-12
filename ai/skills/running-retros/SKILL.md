---
name: running-retros
description: Reviews finished coding sessions for agent-setup friction and proposes at most five enforceable AI-config fixes, with carbon-unit picks handed to /specifying. Use for /running-retros, "retro this session", "what went wrong this session", "review my last sessions", or a SessionStart unreviewed-session reminder. Code-diff reviews belong to /gating-reviews or /reviewing-prs.
---

# Retro

Turn a session's friction into a change the setup enforces, or into nothing. Review corrections, interrupts, hook and permission denials, repeated failures, review rework, reverts, compactions, and costly subagents. Fixes take the form of a hook, test, skill edit, AGENTS.md line, or retirement.

Most sessions teach nothing durable, and saying so is a good outcome. A lesson earns a change only when it recurs or when the carbon unit corrected the agent outright; everything else waits in the ledger for a second sighting.

## Input

```
/running-retros                           the newest transcript for this checkout
/running-retros <session-id>              one session (a SessionStart reminder names it)
/running-retros --since <YYYY-MM-DD>      every session since that date
```

Write every intermediate file only to the scratchpad directory, keeping repos free of intermediates.

## Step 1: Digest

1. Resolve the session. With no argument, the newest `*.jsonl` directly under `~/.claude/projects/<cwd with every / and . replaced by ->/` is this session. Repo key for the ledger: the parent of `git rev-parse --path-format=absolute --git-common-dir`.
2. Run `digest.ts` into a scratch file. Use only the digest as the transcript view in context. Open a transcript line only to settle an ambiguous incident, by line number, with `sed -n '<line>p' <path> | cut -c1-2000`.
3. Zero incidents, zero `prompts`, and zero `specPaths`: record the session as reviewed with an empty run (`report.outcome` `nothing-durable`), tell the carbon unit there is nothing to review, and stop.

## Step 2: Judge in a fresh context

Judge the work only in a fresh context outside the session that did it. Spawn one `general-purpose` agent (Claude only, excluding Codex: digests carry transcript excerpts that may hold secrets). Its prompt carries only these, as file paths it reads itself: the digest file, the `ledger.ts show` output file, and the brief below; excluding candidate incidents or conclusions of your own, which anchor the judge. It reads those files plus the config named in the brief, edits nothing, and is done when `validate-report.ts` accepts its run file at a scratch path.

Judge brief:

- For each digest `specPaths` entry, use its current path, or for a gone `~/.claude/specs` or `~/.claude/spec-archive` path the same relative path under `~/.agents/`; if still gone, find the newest matching `~/.agents/spec-archive/<repo>/<slug>.*.json`, excluding `*.intent.json`. Read the JSON and `node ~/.claude/skills/specifying/render.ts <path> tree`. Zero `specPaths`: no spec judging.
- Judge spec structure for waste and refinement: decisions no unit implements and budget waivers. Only for a spec archived under `~/.agents/spec-archive/` (`<slug>.<built|abandoned>.<date>.json`), also units with no landed `Ticket: <slug>/<id>` commit in the spec's `repoRoot` and size against tickets delivered; a live spec in `~/.agents/specs/` is unbuilt by design, not waste. Lessons become proposals targeting `~/.dotfiles/ai/skills/specifying/` under the same proposal rules below.
- Group incidents into lessons: the one setup gap behind them. Several incidents are often one lesson. Give each a kebab-case `lessonKey`, reusing a `knownLessonKeys` entry when it is the same lesson. Mark a sighting `explicit` when a `correction` incident with `explicit: true`, a digest `prompts` entry in which the carbon unit disputes or corrects the agent, or a `hook-denial`/`repeated-failure` on the same gap supports it; the correction regex misses disputes such as "I see the diagram tho", so read every prompt.
- Count only the digest's incidents and prompts as sightings, excluding friction from your own judging run.
- Discard incidents that are the setup working: a hook denying what it exists to deny, a permission prompt the carbon unit wanted, a test failing on a real bug, a one-off typo. Discard what belongs to the task, not the setup.
- A lesson becomes a proposal only when, counting this run's sightings, it spans two sessions or is explicit (the ledger's `readyLessons` lists those already ready). The rest are recorded as sightings only.
- Read the config the proposal would touch before proposing: `~/.dotfiles/ai/AGENTS.md`, `~/.dotfiles/ai/MODELS.md`, `~/.dotfiles/ai/skills/`, `~/.dotfiles/ai/hooks/`, `~/.dotfiles/ai/agents/`, `~/.dotfiles/ai/settings.base.json`, `~/.dotfiles/profiles/<name>/AGENTS.md`, and the session repo's AGENTS.md nearest the code involved. Propose nothing the config already says unless the proposal is to enforce it.
- Pick the strongest form that would have prevented the incidents: a hook or test first (a rule the agent already broke once as prose needs enforcement, not rewording), then a skill edit, then an AGENTS.md line in the file nearest the code it governs. A hook replaces its prose rather than joining it: its `pairedRetirement` names the skill or AGENTS.md prose its denial message restates, or `none: <reason>`. Agent rules go in AGENTS.md files only, profile-only rules in `profiles/<name>/AGENTS.md`, keeping CLAUDE.md free of agent rules.
- Propose a `retirement` when the session shows a rule, skill step, or hook is dead (its code is gone, a test now pins it) or caused the friction.
- An `agents-line` whose target sits at its byte cap (`~/.dotfiles/ai/hooks/validate-file.mjs` denies growth there) carries `pairedRetirement` naming the rule it retires in the same file; without one, drop the proposal. Keep live rules intact rather than trimming their words to fit.
- Bugs in tools outside the config (Glimmervoid, Claude Code, a CLI) go only in `reported` with an `owner`, outside proposals. Failures in the config repo itself, such as its own failing tests, go only in sightings or proposals, outside `reported`.
- At most five proposals, ranked by what the incidents cost. Zero is a valid answer: `outcome: "nothing-durable"`.
- Write the run file: `{ "report": RetroReport, "sightings": { "<sessionId>": [...] }, "sessions": [...] }` per `lib/report.ts`. Summaries are one line of your own words; keep them free of copied transcript text.

Run `validate-report.ts` on the result; on errors, send the errors back to the same agent once, then stop with the errors if it fails again.

## Step 3: Record

`ledger.ts record-run <run.json>`. This replaces any earlier sightings for these sessions, so each sighting counts once across reruns, and marks the sessions reviewed so the SessionStart reminder drops them.

## Step 4: Pick

Show the proposals from this run plus every pending one from `ledger.ts show`: number, `changeKind`, `target`, summary, and the incidents behind it as `session:line`. List `reported` items separately as things to file elsewhere.

Ask with AskUserQuestion, `multiSelect: true`, one option per proposal, offering at most sixteen per round: this run's first, then the newest pending; a lone proposal is an apply or decline pair. An offered proposal left unpicked is `declined` with `set-status`; say so, since a declined lesson can resurface only through new sightings. A proposal not offered stays `pending` for the next round; say how many.

## Step 5: Apply

1. Group picks by target repository. For the dotfiles, work in a fresh worktree off mainline, keeping `~/.dotfiles` itself untouched: `git -C ~/.dotfiles worktree add <scratchpad>/retro-dotfiles -b retro/<date>-<short id> origin/main`. For the session repo, use a worktree the same way unless this session is already in one with a clean tree.
2. Hand that repository's picks to `/specifying` in that worktree as one request, naming each proposal id and asking for each change as its proposal states, smallest form first; a hook comes with its test under `ai/hooks/test/` and its row in `ai/hooks/AGENTS.md`, and deletes the prose its `pairedRetirement` names. Its build reviews and lands every ticket.
3. Mark a proposal `applied` with `set-status` once the ticket implementing it lands. One whose ticket did not land stays `pending` with the reason reported.
4. Undo is `git revert` of that commit; say which commit holds which proposal.

## Scripts

Run from `~/.claude/skills/running-retros/` with `node`.

- `digest.ts`: `digest.ts <session-id|transcript.jsonl> [--no-git]` or `digest.ts --since <YYYY-MM-DD> [--no-git]` summarizes transcripts in Step 1.
- `ledger.ts`: `ledger.ts show [--repo <abs path>]`, `record-run <run.json>`, and `set-status <proposal-id> applied|declined` for judging context, recording, and picks.
- `validate-report.ts`: `validate-report.ts <report.json>` validates the judge's run file before recording it.

## Hand off

One line per proposal: id, applied, declined or pending, and the commit. Then the `reported` items, and the lessons recorded as single sightings, so the carbon unit knows what is waiting for a second occurrence.
