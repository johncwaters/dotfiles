---
name: qa-swarm
description: Finds defects for the review ladder from an already-pinned diff. Runs a cheap router to rate danger and pick lanes, spawns triggered lanes concurrently, drops findings without proof, and returns one converged STRUCTURED_FINDINGS block. Judges nothing, fixes nothing, and writes nothing. Use when code-review invokes the finder; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical, and every finding carries a `Proof:` the script checks for, so unrun scenarios stay out of triage.

Workflow args: `{ reviewCmd, repoPath, context, changedFiles: string[], codexAllowed: boolean, dispatchNonce?: string, retryAttemptId?: string }`.

## Input

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, the changed-file set that `REVIEW_CMD` produces as repo-relative paths from `git diff --name-only`, the `codexAllowed` flag read off the profile routing rule, and 2 to 4 sentences of context the lanes cannot derive from the diff. The changed-file set is what lanes are scoped to and what the script drops findings against, so a run without it reviews nothing and returns an empty block that reads as clean. Optionally a scope restriction (`-- <paths>`). A change is swept once: no input carries findings from an earlier run.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `code-review`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

**No changed-file set, no run. No routing flag, no run.** The script refuses an absent or empty `changedFiles` or a non-boolean `codexAllowed`, because an empty set drops every finding into a block that reads as clean, and a missing flag could send a work diff to a forbidden CLI.

## Output

**Guaranteed output.** One `STRUCTURED_FINDINGS` block plus one `OVERALL_SUMMARY`, and nothing after them.

**Boundaries.** No verdict, no risk tier, no recommendation to merge or block. No file edits. No git writes. No PR comments. No looping. Those belong to layers above; emitting one here means two layers own the same decision.

## Step 1: Run the workflow

Build `args` from the caller's inputs. When `codexAllowed` is true, set `dispatchNonce` to the output of `openssl rand -hex 8`, run fresh for every call: it makes the `/tmp` prompt path unguessable to other local accounts, and the script refuses a Codex-allowed run without one. Call `Workflow({name: 'qa-swarm', args})`, and relay its result verbatim. A result whose first line is `LANE_DEATH:` is the blocking lane death the caller must fail on. Always call by `name`: the `Workflow(qa-swarm)` allow rule in settings.base.json matches named runs only, and `scriptPath` fails anyway because the tool checks the symlink-resolved path.

To re-run a dead retry under `resumeFromRunId` without replaying its cached output, pass a new `retryAttemptId`.

Workflow tool absent in this session: read `~/.claude/workflows/qa-swarm.js`, spawn the lane set it names in one message with multiple calls, and converge by the rules in that script.

## Step 2: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step. The caller decides what any of it means.

The summary paragraph says: how many findings survived convergence, which lanes ran and which were skipped or degraded, the router's danger and complexity ratings, the filter counts including `Dropped unproven`, and the lanes that hit their own cap, written as the fixed phrase `truncated lanes: <comma-separated lane tags or none>`. Those are facts the caller needs and cannot recover. That one phrase is worded verbatim, always present, and `none` when nothing capped, because the caller parses it rather than reads it.

## Lane reference

Lane definitions and selection belong to `~/.claude/workflows/qa-swarm.js`.
`security` stays on fable because security judgment outranks cost.

**CLI routing flag.** Read the profile `<routing>` rule in context yourself: a rule forbidding Codex sets `codexAllowed` false, and no such rule means true. Keep detection in this session rather than a spawned agent, which is told routing does not bind it. Sending a work diff to a forbidden CLI is a confidentiality breach, not a routing preference. The router is the only step that reaches Codex (`gpt-6.1-sol`), so a run has a read on a different model only when Codex routes; either way it returns the defects it proved while classifying. A false flag emits no Codex instruction and routes on `opus` with the same prompt.

## Reviewer output format

Relay the workflow output verbatim; manual lanes use `~/.claude/agents/*-reviewer.md` for their formats and `~/.claude/workflows/qa-swarm.js` for the converged output.

## Token discipline

- A run is a router pass plus one `code` lane. Every extra lane is another full pass.
- Pass `REVIEW_CMD` instead of diff text; let the lane run git itself.
- The router keeps lanes on needed work only. A plan that delegates everything every time means the router prompt is wrong.
