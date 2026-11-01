---
name: converging-reviews
description: Runs review and fix rounds over local work until a round finds nothing left to fix, then hands the tree to /landing. Every round runs every lane, uncapped; round 1 reviews the whole working diff, a later round reviews the previous round's fixes, a clean fix round triggers a whole-diff sweep, and round.mjs classifies every round against a ledger so the loop stops on a stall, a cap of 8 rounds, or a question. Starts only by name. Use for /converging-reviews.
---

# Converging Reviews

An experiment: the review ladder with the loop it otherwise forbids, made safe by rules `round.mjs` enforces. A fix round reviews only the delta its fixes made, and only HIGH+ counts there; once one is clean, a sweep re-reviews the whole diff, where MEDIUM+ counts on the first sweep and HIGH+ after, so the loop tapers instead of minting fresh MEDIUMs. The `ACTIONABLE` count must strictly fall against the previous round of the same kind, and a fixed finding coming back means the fixes are fighting; a finding a carbon unit ruled NIT or the writer declined stays dropped. Starting only by name keeps it an experiment: `/landing` stays the default gate.

## Input

Uncommitted local work on a feature branch, and one or two sentences of what changed and the goal it serves.

## Output

The tree landed through `/landing` on `CLEAN`, or a stop report on `STALLED`, `CAPPED`, or `FAILED` naming the round, the ledger path, and every live `ACTIONABLE` finding. The ledger stays for the next run either way.

## Step 1: Preflight and start

Run `node "$HOME/.claude/skills/landing/preflight.ts"` and act on it as `/landing` Step 1 says, integrating mainline before round 1 so no merge lands inside the loop; its `paths` are the changed-file set. Pin the working tree once through a throwaway index, as `reviewing-code` Step 1 does for `working`, giving `TREE_1`. Then:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" start --tree "$TREE_1"
```

`FRESH` returns round 1 and `base`, which is `TREE_0`, the HEAD tree; it sets any older ledger aside. `RESUME` returns the round an `ASKED` stop left on this same tree: rerun that round's `classify` on the same review return and swarm output, since a fresh swarm rewords findings and the ruling is keyed by fingerprint. Review again only when that return is lost.

No cleaning pass runs: on a whole uncommitted pull request it deletes values a stacked change may use, and the loop edits only what a finding proves.

## Step 2: Review and classify

Invoke `/reviewing-code` with `uncapped`, `allLanes`, the context, `BASE` and head `TREE_N` as its base-and-head form, and `git diff --name-only BASE TREE_N` as the changed-file set. `BASE` is `TREE_{N-1}`, except in a sweep round, where it is the `base` the `SWEEP` outcome returned. Every round keeps every lane so a fix round cannot narrow which concerns get checked. This session triages the return, then fixes in Step 4.

Note the output file the qa-swarm Workflow notification names, and pipe the whole `/reviewing-code` return into:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" classify --round N --base BASE --head TREE_N --swarm-output <qa-swarm output file>
```

`classify` takes each finding's body verbatim from the swarm output, drops findings the ledger already settled and findings anchored away from the round's hunks (`droppedOffHunk`), then prints the outcome, the kept `actionable` (at or above the round's `severityFloor`, recounted, unlike `/reviewing-code`'s `ACTIONABLE` header), `asked`, and below-HIGH `ambiguous` findings. `unmatchedBodies` counts findings whose body it could not match. It also runs the repo's push gate in the working tree: the first `package.json` script its pre-push hook invokes (husky's `.husky/pre-push` included), else the hook itself, else `check:fast`, else `test`. A failure becomes a HIGH `ACTIONABLE` `gate/<name>` finding that no ruling settles while the gate still fails, so a round cannot end clean on a tree the push would reject; `gate` in its output names what ran, or `null` when the repo has none, which the report says.

## Step 3: Act on the outcome

| Outcome | Exit | Action |
|---|---|---|
| `CLEAN` | 0 | Run `/landing`; its review skips only when `round.mjs verify`, which pins the working tree itself, finds it equal to this CLEAN head, so an edit made after CLEAN still gets reviewed |
| `CONTINUE` | 10 | Step 4, then the next round from Step 2 |
| `RETRY` | 11 | Repeat Step 2 for the same round once |
| `SWEEP` | 12 | Run round `nextRound` from Step 2 with its `base` and the same head; no fix lands between |
| `ASKED` | 20 | Put each `asked` finding to the carbon unit with both readings, record the ruling, then rerun from Step 1 |
| `STALLED` | 21 | Stop and report |
| `CAPPED` | 22 | Stop and report |
| `FAILED` | 23 | Stop and report; a truncated lane fails too, since nothing would sweep its overflow |

State both readings of an `asked` finding from the code alone. A pull request's review threads or the author's replies are not a reading: the question is what this review would have the code do.

Record a ruling with `round.mjs record --fingerprint <fp> --ruling NIT|ACTIONABLE`.

The final report of every outcome, `CLEAN` included, names each `ambiguous` finding any round kept and any nonzero `unmatchedBodies`, since no outcome stops for them. A stop's report also names the round, the ledger path, every live `actionable` finding with its `Proof:`, and any suite that could not run; a stop leaves the tree uncommitted.

## Step 4: Fix and pin

Hand every `actionable` finding to `~/.claude/skills/landing/subskills/fix.md`. The write scope is the changed-file set plus each file a finding's `Proof:` cites at file:line, so a fix lands at its upstream source when the finding traces it there. Record each outcome:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" record --fingerprint <fp> --fix FIXED|UNVERIFIED|DECLINED --round N
```

Fix a `gate/<name>` finding at its root cause like any other; with `gate: null`, run the suite covering the changed files instead, and a suite that cannot run here goes in the report by name, with what ran instead. Pin the tree as `TREE_{N+1}`, the next round's head; `TREE_N` is its base.

## Scripts

- `round.mjs`: `start`, `classify` (`--swarm-output` reads the qa-swarm task output file), `record`, and `verify`; keeps the ledger at `~/.claude/converging-reviews/<repo>/<branch>.jsonl` (`CONVERGING_REVIEWS_DIR` overrides) and owns every stop rule.
