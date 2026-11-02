---
name: swarming-reviews
description: Finds defects for the review ladder from an already-pinned diff. Picks lanes with deterministic path and diff rules, starts them at once while a cheap router adds any lane the rules missed, drops findings without proof, and returns one converged STRUCTURED_FINDINGS block. Judges nothing, fixes nothing, and writes nothing. Use when reviewing-code invokes the finder; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical, and every finding carries a `Proof:` the script checks for, so unrun scenarios stay out of triage.

Workflow args: `{ reviewCmd, repoPath, context, changedFiles: string[], ruleLanes, retryAttemptId?: string, findingCap?: number | null }`; `findingCap: null` when the caller asked uncapped.

## Input

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, the changed-file set that `REVIEW_CMD` produces as repo-relative paths from `git diff --name-only`, and 2 to 4 sentences of context the lanes cannot derive from the diff. The changed-file set is what lanes are scoped to and what the script drops findings against, so a run without it reviews nothing and returns an empty block that reads as clean. A change is swept once: no input carries findings from an earlier run.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `reviewing-code`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

## Output

**Guaranteed output.** One `STRUCTURED_FINDINGS` block plus one `OVERALL_SUMMARY`, and nothing after them.

**Boundaries.** No verdict, no risk tier, no recommendation to merge or block. No file edits. No git writes. No PR comments. No looping. Those belong to layers above; emitting one here means two layers own the same decision.

## Step 1: Pick rule lanes

Run `node ~/.claude/skills/swarming-reviews/scripts/route-lanes.mjs --review-cmd "<REVIEW_CMD>" --repo <repo path> -- <changed files>` (`--all-lanes` when asked all lanes) and pass its JSON as `ruleLanes`. Exit 2: unreadable diff; stop and report it. Refused: pass `{lanes: ['code'], filesByLane: {code: <changed files>}}` and still run Step 2; the workflow router widens it.

## Step 2: Run the workflow

Call `Workflow({name: 'qa-swarm', args})` and relay its result verbatim. A result whose first line is `LANE_DEATH:` is the blocking lane death the caller must fail on. Always call by `name`: the `Workflow(qa-swarm)` allow rule matches named runs only, and `scriptPath` fails on the symlink-resolved path.

To re-run a dead retry under `resumeFromRunId` without replaying its cached output, pass a new `retryAttemptId`.

No Workflow tool: read `~/.claude/workflows/qa-swarm.js`, spawn its rule lanes in one message, and converge by its rules.

## Step 3: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step.

The summary paragraph says how many findings survived, which lanes ran, were skipped, or degraded, the filter counts including `Dropped unproven`, and the fixed phrase `truncated lanes: <comma-separated lane tags or none>`, worded verbatim and always present, because the caller parses it.

## Lane reference

Lane definitions belong to `~/.claude/workflows/qa-swarm.js`; manual lanes use `~/.claude/agents/*-reviewer.md` for their formats. `security` stays on fable because security judgment outranks cost.

## Scripts

- `scripts/route-lanes.mjs`: picks lanes from changed paths and lines; run in Step 1.
