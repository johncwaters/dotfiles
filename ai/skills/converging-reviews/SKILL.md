---
name: converging-reviews
description: Runs review and fix rounds over local work until a round finds nothing left to fix, then hands the tree to /committing. Round 1 reviews the whole working diff uncapped; each later round reviews only the previous round's fixes, and round.mjs classifies every round against a ledger so the loop stops on a stall, a cap of 8 rounds, or a question. Starts only by name. Use for /converging-reviews.
---

# Converging Reviews

An experiment: the review ladder with the loop it otherwise forbids, made safe by three rules `round.mjs` enforces. Each round after the first reviews only the delta its fixes made, so the same diff is swept once; the MEDIUM+ `ACTIONABLE` count must strictly fall, and a fixed finding coming back means the fixes are fighting; a finding a carbon unit ruled NIT or the writer declined stays dropped. Starting only by name keeps it an experiment: `/committing` stays the default gate.

## Input

Uncommitted local work on a feature branch, and one or two sentences of what changed and the goal it serves.

## Output

The tree landed through `/committing` on `CLEAN`, or a stop report on `STALLED`, `CAPPED`, or `FAILED` naming the round, the ledger path, and every live `ACTIONABLE` finding. The ledger stays for the next run either way.

## Step 1: Preflight and start

Run `node "$HOME/.claude/skills/committing/preflight.ts"` and act on it as `/committing` Step 1 says, integrating mainline before round 1 so no merge lands inside the loop; its `paths` are the changed-file set. Pin the working tree through a throwaway index, as `reviewing-code` Step 1 does for `working`, giving `TREE`. Then:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" start --tree "$TREE"
```

`FRESH` returns round 1 and `base`, which is `TREE_0`, the HEAD tree; it sets any older ledger aside. `RESUME` returns the round an `ASKED` stop left on this same tree: redo that round's review and classify in Step 3, since the carbon unit's ruling is now in the ledger.

## Step 2: Clean once

On `FRESH` only, run `cleaning-ai-slop` on the changed-file set, edits limited to lines already changed, existing tests only. Re-pin the tree after it as `TREE_1`, round 1's `head`.

## Step 3: Review and classify

Invoke `/reviewing-code` with `uncapped`, the context, and:

- round 1: target `working`, the changed-file set; classify it with `--base TREE_0 --head TREE_1`
- round N: target base `TREE_{N-1}` and head `TREE_N`, with `git diff --name-only TREE_{N-1} TREE_N` as the changed-file set

Pipe its whole return into:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" classify --round N --base <base> --head <head>
```

`classify` drops findings the ledger already settled and findings anchored away from the round's hunks, then prints the outcome, the kept `actionable`, `asked`, and below-HIGH `ambiguous` findings, and the drop counts per reviewer. Name every `ambiguous` finding in the final report, since no outcome stops for it.

## Step 4: Act on the outcome

| Outcome | Exit | Action |
|---|---|---|
| `CLEAN` | 0 | Run `/committing`; its review skips only when `round.mjs verify`, which pins the working tree itself, finds it equal to this CLEAN head, so an edit made after CLEAN still gets reviewed |
| `CONTINUE` | 10 | Step 5, then the next round from Step 3 |
| `RETRY` | 11 | Repeat Step 3 for the same round once |
| `ASKED` | 20 | Put each `asked` finding to the carbon unit with both readings, record the ruling, then rerun from Step 1 |
| `STALLED` | 21 | Stop and report |
| `CAPPED` | 22 | Stop and report |
| `FAILED` | 23 | Stop and report; a truncated lane fails too, since nothing would sweep its overflow |

Record a ruling with `round.mjs record --fingerprint <fp> --ruling NIT|ACTIONABLE`.

## Step 5: Fix and pin

Hand every `actionable` finding to `~/.claude/skills/committing/subskills/fix.md`. The write scope is the changed-file set plus each file a finding's `Proof:` cites at file:line, so a fix lands at its upstream source when the finding traces it there. Record each outcome:

```
node "$HOME/.claude/skills/converging-reviews/round.mjs" record --fingerprint <fp> --fix FIXED|UNVERIFIED|DECLINED --round N
```

Run the suite covering the changed files and fix a failure at its root cause; a suite that cannot run here goes in the final report by name, with what ran instead. Pin the tree as `TREE_{N+1}`, the next round's head; `TREE_N` is its base.

## Scripts

- `round.mjs`: `start`, `classify`, `record`, and `verify`; keeps the ledger at `~/.claude/converging-reviews/<repo>/<branch>.jsonl` (`CONVERGING_REVIEWS_DIR` overrides) and owns every stop rule.
