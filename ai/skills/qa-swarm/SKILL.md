---
name: qa-swarm
description: The finder engine of the review ladder. Takes an already-pinned diff reference, runs a cheap router pass to rate danger and pick reviewer lanes, spawns the triggered lanes concurrently, and returns one converged STRUCTURED_FINDINGS block. It judges nothing, fixes nothing, and writes nothing. Invoked by code-review; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical.

Workflow args: `{ reviewCmd, repoPath, context, changedFiles: string[], codexAllowed: boolean, dispatchNonce?: string, settled: string[], claimedFixed: string[], declined: string[], round?: { number, touchedFiles: string[], reportingBar: string }, retryAttemptId?: string }`.

## Contract with the caller

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, the changed-file set that `REVIEW_CMD` produces as repo-relative paths from `git diff --name-only`, the `codexAllowed` flag read off the profile routing rule, and 2 to 4 sentences of context the lanes cannot derive from the diff. The changed-file set is what every lane is scoped to and what the script drops findings against, so a run without it reviews nothing and returns an empty block that reads as clean. Optionally a scope restriction (`-- <paths>`), and, from an earlier round, three separate lists: findings already settled as `NIT` or `AMBIGUOUS`, which lanes are told not to re-report; findings a writer claims to have fixed, which lanes are told to **check specifically** and to report again at whatever severity if the defect is still there, exempt from any reporting bar; and findings a writer declined, which lanes are told to report again if still present, likewise exempt from any bar. When the caller sends round state, also pass the round number, the caller-computed touched-file set, and the caller's reporting bar for this round. The three lists must never be merged: telling a lane to skip a finding somebody claims to have fixed is how an unverified fix becomes an approval, and a declined finding is neither settled nor claimed fixed, so folding it into either list buries a live defect the writer refused to touch.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `code-review`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

**No changed-file set, no run. No routing flag, no run.** The script refuses an absent or empty `changedFiles` or a non-boolean `codexAllowed`, because an empty set drops every finding into a block that reads as clean, and a missing flag could send a work diff to a forbidden CLI.

**Guaranteed output.** One `STRUCTURED_FINDINGS` block plus one `OVERALL_SUMMARY`, and nothing after them.

**Never.** No verdict, no risk tier, no recommendation to merge or block. No file edits. No git writes. No PR comments. No looping. Those belong to layers above; emitting one here means two layers own the same decision.

## Lane reference

Lane definitions and selection belong to `~/.claude/workflows/qa-swarm.js`.
`security` stays on fable because security judgment outranks cost.

**CLI routing flag.** Read the profile `CLAUDE.md` `<routing>` rule yourself: a rule forbidding Codex sets `codexAllowed` false, and no such rule means true. Never leave detection to a spawned agent, which is told routing does not bind it. Sending a work diff to a forbidden CLI is a confidentiality breach, not a routing preference. A false flag emits no Codex instruction and uses the substitute below:

| Lane | CLI route | False-flag substitute |
|---|---|---|
| router | Codex `gpt-6.1-sol` | `opus`, same prompt, when `codexAllowed` is false |
| `external` | Codex `gpt-6.1-sol` | `opus`, adversarially refuting the other lanes, when `codexAllowed` is false |

## Reviewer output format

Relay the workflow output verbatim; manual lanes use `~/.claude/agents/*-reviewer.md` for their formats and `~/.claude/workflows/qa-swarm.js` for the external lane and converged output.

## Step 1: Run the workflow

Build `args` from the caller's inputs. When `codexAllowed` is true, set `dispatchNonce` to the output of `openssl rand -hex 8`, run fresh for every call: it makes the `/tmp` prompt path unguessable to other local accounts, and the script refuses a Codex-allowed run without one. Call `Workflow({name: 'qa-swarm', args})`, and relay its result verbatim. A result whose first line is `LANE_DEATH:` is the blocking lane death the caller must fail on. Always call by `name`: the `Workflow(qa-swarm)` allow rule in settings.base.json matches named runs only, and `scriptPath` fails anyway because the tool checks the symlink-resolved path.

To re-run a dead retry under `resumeFromRunId` without replaying its cached output, pass a new `retryAttemptId`.

Workflow tool absent in this session: read `~/.claude/workflows/qa-swarm.js`, spawn the lane set it names in one message with multiple calls, as before, and converge by the rules in that script.

## Step 2: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step. The caller decides what any of it means.

The summary paragraph says: how many findings survived convergence, which lanes ran and which were skipped or degraded, the router's danger and complexity ratings or the follow-up routing note, the filter counts, and the lanes that hit their own cap, written as the fixed phrase `truncated lanes: <comma-separated lane tags or none>`. Those are facts the caller needs and cannot recover. That one phrase is worded verbatim, always present, and `none` when nothing capped, because the caller parses it rather than reads it.

## Token discipline

- Round 1 has a router pass plus one `code` lane. Follow-up rounds with touched files skip the router. Every extra lane is another full pass, and `security` runs on fable, the priciest tier.
- Never paste diff text into a prompt. Hand over `REVIEW_CMD` and let the lane run git itself.
- Diffs over roughly 2000 changed lines: tell each lane to prioritize by risk within its scope. Do not answer size by adding lanes.
- The router exists to keep lanes off work they do not need. A plan that delegates everything every time means the router prompt is wrong.
