---
name: challenging-plans
description: Challenges a fresh plan with read-only subagents to simplify every step. A simplify lane argues for cutting, shrinking, or merging each step, and a scale lane, when the plan handles growing data, argues for the lowest algorithmic bound. The caller re-checks each verdict, records it in a ledger, revises the plan, and stamps it with a CHALLENGE line. Use when the specifying skill reaches its challenge step or a drafted plan needs a direct challenge.
---

# Plan Challenge

Every step is guilty until justified. The simplify lane presses necessity and reuse, the scale lane presses bounds; the output is a plan at most the original size.

## Input

**Required input.** The draft plan with numbered steps, the goal it serves in one or two sentences, and the repo path. When the caller knows what the goal tolerates (stale reads, a lost write, one writer, tail latency), the goal names it: an unstated tolerance cannot cut the step that guards against it.

## Output

**Guaranteed output.** A revised plan, a ledger of every verdict and its outcome, and as the last line the stamp:

```
CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut
```

The `specifying` skill stores the ledger as `challengeLedger` and the stamp as `challengeStamp`; its validator recounts the stamp from the ledger. Writing either without running the lanes is a violation.

**Boundaries.** Challengers argue without editing files, rewriting the plan, or adding work. A challenge that proposes a new step is dropped: the only legal moves are cut, shrink, merge, keep.

## Step 1: Run the workflow

Add `scale` to `lanes` when any step loops over data that grows with use (rows, files, board elements, requests, sessions); `simplify` always runs. Call `Workflow({name: 'plan-challenge', args: { goal, planText, repoPath, lanes }})`. To re-run a dead lane retry under `resumeFromRunId`, add a new `retryAttemptId`. `lanes` returns each surviving lane's parsed `verdicts`; add `(lanes: <names>)` to the stamp when a requested lane is missing from `survivingLanes`. Restate a prose plan as a numbered list (`1.`, one line per step at column zero) before calling. Always call by `name`: the `Workflow(plan-challenge)` allow rule matches named runs only.

Workflow tool absent and no mapping for one in your tool notes: read `~/.claude/workflows/plan-challenge.js`, spawn its selected lanes in one message, and parse them by its rules.

## Step 2: Judge

The caller judges; challengers only argue. Per step, take the most aggressive verdict (CUT beats SHRINK beats KEEP), then re-check its cited evidence in the repo. It applies only when that check holds; `unverified` evidence, or evidence the check contradicts, is rebutted. A verified CUT or SHRINK is escaped only by a rebuttal naming the concrete failure without the step; "might need it later", "best practice", and "small anyway" lose. A scale SHRINK is escaped only by naming the fact that bounds the input (an enum, a config cap, a fixed list) and where it lives.

No lane surviving is no challenge: return the plan unstamped.

## Step 3: Record, revise, and stamp

Write one ledger step per original step: `{ step, unitIds, verdicts, outcome, rebuttal }`, `verdicts` as the workflow returned them with `lane` added, `outcome` `kept`, `shrunk` (a merged step counts as shrunk), or `cut`, and `rebuttal` on a kept step that drew a CUT or SHRINK.

Apply the outcomes, merge and renumber, one short line per step. Under the steps, list a `Bounds:` block, one line per surviving step: a scale SHRINK's lowered bound, `O(n) in rows; no cache` for a same-bound cache SHRINK, every absorbed bound for a merge, or `O(n²) in rows; O(n log n) needs an index on created_at` when a scale KEEP named the infrastructure a lowering needs. Append the stamp, counted from the ledger outcomes.
