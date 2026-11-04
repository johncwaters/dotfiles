---
name: converging-reviews
description: Runs review and fix rounds over local work until a round finds nothing left to fix, then stamps the tree for /landing. Every round runs every lane, uncapped; round 1 reviews the whole working diff, a later round reviews the previous round's fixes, a clean fix round triggers a whole-diff sweep, and round.mjs classifies every round against a ledger so the loop stops on a cap of 8 rounds or a question. Starts only by name. Use for /converging-reviews.
---

# Converging Reviews

An experiment: the review ladder with the loop it otherwise forbids, made safe by rules `round.mjs` enforces. A fix round reviews only the delta its fixes made; once one is clean, a sweep re-reviews the whole diff. Every `ACTIONABLE` finding counts at any severity, since a floor ships a proven defect unfixed; only the cap bounds the loop, since without a floor a flat count at the tail is a converging loop, not a stuck one. A finding a carbon unit ruled NIT or the writer declined stays dropped. Starting only by name keeps it an experiment: `/gating-reviews` stays the default gate.

## Input

Uncommitted local work on a feature branch, and one or two sentences of what changed and the goal it serves.

## Output

A review stamp over the changed-file set on `CLEAN`, which the caller lands through `/landing`, or a stop report on `CAPPED` or `FAILED` naming the round, the ledger path, and every live `ACTIONABLE` finding. The ledger stays for the next run either way.

## Step 1: Preflight and start

Run `node "$HOME/.claude/skills/landing/preflight.ts"` and act on it as `/gating-reviews` [Preflight](../gating-reviews/SKILL.md#preflight) says, integrating mainline before round 1 only when its `next` says `rerun`, since uncommitted work stays in the tree and `land.ts --promote` integrates after the loop; its `paths` are the changed-file set. Then:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" start
```

`round.mjs` pins every tree itself and keeps it in the ledger, so no tree id lives in this session's context. `FRESH` returns round 1 with its `kind`, `base` (the HEAD tree), `head` (the pinned working tree) and `reviewCmd`; it sets any older ledger aside. `RESUME` returns the round an `ASKED` stop left on this same tree: rerun that round's `classify` on the same review return and swarm output, since a fresh swarm rewords findings and the ruling is keyed by fingerprint. Review again only when that return is lost.

No cleaning pass runs: on a whole uncommitted pull request it deletes values a stacked change may use, and the loop edits only what a finding proves.

## Step 2: Review and classify

Invoke `/reviewing-code` with `uncapped`, `allLanes`, the context, the round's `base` and `head` from `start` or `next` as its base-and-head form, and `git diff --name-only <base> <head>` as the changed-file set. After a compaction, `round.mjs next` prints the round in flight again. Every round keeps every lane so a fix round cannot narrow which concerns get checked. A delta round's `fixed` lists each defect the previous round's fixes claim to remove; put it in the context and ask whether each fix removed its defect everywhere in the diff, siblings and the test that pins it included, since a partial fix otherwise surfaces only in a later sweep. This session triages the return, then fixes in Step 4.

Note the output file the qa-swarm Workflow notification names, and pipe the whole `/reviewing-code` return into:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" classify --round N --swarm-output <qa-swarm output file>
```

`classify` takes each finding's body verbatim from the swarm output, drops findings the ledger already settled and findings anchored away from the round's hunks (`droppedOffHunk`), then prints the outcome, the kept `actionable` (every severity, recounted, unlike `/reviewing-code`'s `ACTIONABLE` header), `asked`, and below-HIGH `ambiguous` findings. `unmatchedBodies` counts findings whose body it could not match. It also runs the repo's push gate in the working tree: the first `package.json` script its pre-push hook invokes (husky's `.husky/pre-push` included), else the hook itself, else `check:fast`, else `test`. A failure becomes a HIGH `ACTIONABLE` `gate/<name>` finding that no ruling settles while the gate still fails, so a round cannot end clean on a tree the push would reject; `gate` in its output names what ran, or `null` when the repo has none, which the report says.

## Step 3: Act on the outcome

| Outcome | Exit | Action |
|---|---|---|
| `CLEAN` | 0 | Before any further edit, run `round.mjs stamp <preflight paths>`. It stamps only a tree equal to this CLEAN head, carrying every `UNVERIFIED` fix; `UNSTAMPED` (exit 24) means the tree moved, so rerun from Step 1. `BROWSER_CODE_FAILED` (exit 30) lists the `/securing-browser-code` failures blocking an owned repo: fix them as new work, then rerun from Step 1. An edit after the stamp makes `land.ts` return `NOT_REVIEWED` |
| `CONTINUE` | 10 | Step 4, then `round.mjs next` and Step 2 |
| `RETRY` | 11 | Repeat Step 2 for the same round once |
| `SWEEP` | 12 | `round.mjs next`, then Step 2; no fix lands between |
| `ASKED` | 20 | Put each `asked` finding to the carbon unit with both readings, record the ruling, then rerun from Step 1 |
| `CAPPED` | 22 | Stop and report, writing no stamp; inside a build this stops the build |
| `FAILED` | 23 | Stop and report, writing no stamp; inside a build this stops the build. A truncated lane fails too, since nothing would sweep its overflow |

State both readings of an `asked` finding from the code alone. A pull request's review threads or the author's replies are not a reading: the question is what this review would have the code do.

Record a ruling with `round.mjs record --fingerprint <fp> --ruling NIT|ACTIONABLE`.

The final report of every outcome, `CLEAN` included, names each `ambiguous` finding any round kept and any nonzero `unmatchedBodies`, since no outcome stops for them. A stop's report also names the round, the ledger path, every live `actionable` finding with its `Proof:`, and any suite that could not run; a stop leaves the tree uncommitted.

## Step 4: Fix and pin

Hand every `actionable` finding to `~/.claude/skills/gating-reviews/subskills/fix.md`. The write scope is the changed-file set plus each file a finding's `Proof:` cites at file:line, so a fix lands at its upstream source when the finding traces it there. Record each outcome:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" record --fingerprint <fp> --fix FIXED|UNVERIFIED|DECLINED --round N
```

Fix a `gate/<name>` finding at its root cause like any other; with `gate: null`, run the suite covering the changed files instead, and a suite that cannot run here goes in the report by name, with what ran instead. Then run `round.mjs next`, which pins the fixed tree as the next round's head over this round's head as base.

## Scripts

- `round.mjs`: `start`, `next`, `classify` (`--swarm-output` reads the qa-swarm task output file), `record`, and `stamp`; keeps the ledger at `~/.claude/converging-reviews/<repo>/<branch>.jsonl` (`CONVERGING_REVIEWS_DIR` overrides) and owns every stop rule.
