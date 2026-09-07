---
name: qa-swarm
description: The finder engine of the review ladder. Takes an already-pinned diff reference, runs a cheap router pass to rate danger and pick reviewer lanes, spawns the triggered lanes concurrently, and returns one converged STRUCTURED_FINDINGS block. It judges nothing, fixes nothing, and writes nothing. Invoked by code-review; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical.

Workflow args: `{ reviewCmd, repoPath, context, changedFiles: string[], claudeOnly: boolean, settled: string[], claimedFixed: string[], declined: string[], round?: { number, touchedFiles: string[], reportingBar: string } }`.

## Contract with the caller

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, the changed-file set that `REVIEW_CMD` produces as repo-relative paths from `git diff --name-only`, the `claudeOnly` flag read off the profile routing rule, and 2 to 4 sentences of context the lanes cannot derive from the diff. The changed-file set is what every lane is scoped to and what the script drops findings against, so a run without it reviews nothing and returns an empty block that reads as clean. Optionally a scope restriction (`-- <paths>`), and, from an earlier round: three separate lists — findings already settled as `NIT` or `AMBIGUOUS`, which lanes are told not to re-report; findings a writer claims to have fixed, which lanes are told to **check specifically** and to report again at whatever severity if the defect is still there, exempt from any reporting bar; and findings a writer declined, which lanes are told to report again if still present, likewise exempt from any bar — plus, when the caller sends round state, the round number, the caller-computed touched-file set, and the caller's reporting bar for this round. The three lists must never be merged: telling a lane to skip a finding somebody claims to have fixed is how an unverified fix becomes an approval, and a declined finding is neither settled nor claimed fixed, so folding it into either list buries a live defect the writer refused to touch.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `code-review`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

**No changed-file set, no run. No `claudeOnly` flag, no run.** The script refuses an absent or empty `changedFiles` and a `claudeOnly` that is not a boolean, because an empty set drops every finding into a block that reads as clean, and a missing flag would send a work diff to Codex by default.

**Guaranteed output.** One `STRUCTURED_FINDINGS` block plus one `OVERALL_SUMMARY`, and nothing after them.

**Never.** No verdict, no risk tier, no recommendation to merge or block. No file edits. No git writes. No PR comments. No looping. Those belong to layers above; emitting one here means two layers own the same decision.

## Lane reference

| Lane tag | Target | Model | Triggers when |
|---|---|---|---|
| `code` | `code-reviewer` agent | opus | Always. Logic defects, correctness, contracts |
| `security` | `security-reviewer` agent | fable | Diff touches auth, input handling, crypto, payments, PII, secrets, infrastructure, or destructive operations |
| `structure` | `structure-reviewer` agent | opus | Diff is a refactor, establishes a new module or boundary, or moves responsibilities across existing ones |
| `necessity` | `necessity-reviewer` agent | opus | Diff introduces a net-new file, exported symbol, or doc section, and the context states a goal |
| `scale` | `scale-reviewer` agent | opus | Diff adds or changes a loop, recursion, query, batch, cache, or list endpoint whose input the context does not bound by fact |
| `external` | Codex CLI | `gpt-5.6-sol`, effort `high` | Danger or complexity is HIGH. An independent frontier read of the same diff |
| `tiebreak` | Grok CLI | default | Two lanes disagree on whether a specific finding is real. Runs during convergence inside the workflow, never during lane dispatch |

The trigger column is a copy of the rows `laneTriggerTable` renders from the `laneDefinitions` array in `~/.claude/workflows/qa-swarm.js`, which is the text the router prompt actually carries; edit a lane's `trigger` there first and copy the rendered row here. The script pins these models. `security` stays on fable because security judgment outranks cost.

**Claude-only machines.** A profile `CLAUDE.md` whose `<routing>` forbids external model CLIs (the work profile does, and its rule wins over `~/.claude/ROUTING.md`) forbids them here too. Sending a work diff to Codex or Grok is a confidentiality breach, not a routing preference. Read that rule yourself and pass `claudeOnly: true`, which makes the script emit no Codex or Grok instruction in any prompt; never leave the detection to a spawned agent, which is told routing does not bind it. Substitute, and say in the summary that the Claude-only route was used:

| Lane | External route | Claude-only substitute |
|---|---|---|
| router | Codex `gpt-5.6-terra` | an `opus` agent, same prompt |
| `external` | Codex `gpt-5.6-sol` | a second `opus` agent over the same diff, prompted adversarially to refute the other lanes' findings rather than to repeat them |
| `tiebreak` | Grok | an `opus` agent given both positions and nothing else |

## Reviewer output format

Every lane, and this skill itself, ends its response with:

```
STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM|LOW> | reviewer: <tag> | body: <the review comment text>
- file: ...

OVERALL_SUMMARY:
<one paragraph>
```

No findings:

```
STRUCTURED_FINDINGS:
(none)

OVERALL_SUMMARY:
<one paragraph>
```

**Tags** are `<lane>` or `<lane>/<category>`, the category being the finding's own lowercased, hyphenated kind: `security/idor`, `code/logic`, `structure/duplication`, `scale/quadratic`. Sub-tagging keeps each lane's taxonomy readable once findings converge; fall back to the flat lane tag when no category fits.

**`body`** is compact: what is wrong, the failure scenario, the fix, and `Confidence: low, <what would confirm it>` when the lane could not fully verify it. One finding per line, no newlines and no bare `|` inside a body.

**`side`** says which half of the diff `line` indexes: `RIGHT` for a line the diff adds or leaves in place, `LEFT` for a line the diff removes, in which case `line` is its number in the pre-change file. Default to `RIGHT`; a lane that reports a defect in deleted code must say `LEFT` explicitly. Nothing downstream can recover this from the finding alone, and a `LEFT` finding published as `RIGHT` lands on unrelated code. Omit the field entirely when `line` is `general`.

Lanes emit LOW at minimum and never `NIT`. Only code-review may use `NIT` as a disposition.

## Step 1: Run the workflow

Build `args` from the caller's inputs, call `Workflow({name: 'qa-swarm', args})`, and relay its result verbatim. A result whose first line is `LANE_DEATH:` is the blocking lane death the caller must fail on.

Workflow tool absent in this session: read `~/.claude/workflows/qa-swarm.js`, spawn the lane set it names in one message with multiple calls, as before, and converge by the rules in that script.

## Step 2: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step. The caller decides what any of it means.

The summary paragraph says: how many findings survived convergence, which lanes ran and which were skipped or degraded, the router's danger and complexity ratings, and the lanes that hit their own cap, written as the fixed phrase `truncated lanes: <comma-separated lane tags or none>`. Those are facts the caller needs and cannot recover. That one phrase is worded verbatim, always present, and `none` when nothing capped, because the caller parses it rather than reads it.

## Token discipline

- Floor is a router pass plus one `code` lane. Every extra lane is another full pass, and `security` runs on fable, the priciest tier.
- Never paste diff text into a prompt. Hand over `REVIEW_CMD` and let the lane run git itself.
- Diffs over roughly 2000 changed lines: tell each lane to prioritize by risk within its scope. Do not answer size by adding lanes.
- The router exists to keep lanes off work they do not need. A plan that delegates everything every time means the router prompt is wrong.
