---
name: qa-swarm
description: The finder engine of the review ladder. Takes an already-pinned diff reference, runs a cheap router pass to rate danger and pick reviewer lanes, spawns the triggered lanes concurrently, and returns one converged STRUCTURED_FINDINGS block. It judges nothing, fixes nothing, and writes nothing. Invoked by code-review; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical.

Workflow args: `{ reviewCmd, repoPath, context, changedFiles: string[], codexAllowed: boolean, grokAllowed: boolean, settled: string[], claimedFixed: string[], declined: string[], round?: { number, touchedFiles: string[], reportingBar: string } }`.

## Contract with the caller

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, the changed-file set that `REVIEW_CMD` produces as repo-relative paths from `git diff --name-only`, the `codexAllowed` and `grokAllowed` flags read off the profile routing rule, and 2 to 4 sentences of context the lanes cannot derive from the diff. The changed-file set is what every lane is scoped to and what the script drops findings against, so a run without it reviews nothing and returns an empty block that reads as clean. Optionally a scope restriction (`-- <paths>`), and, from an earlier round, three separate lists: findings already settled as `NIT` or `AMBIGUOUS`, which lanes are told not to re-report; findings a writer claims to have fixed, which lanes are told to **check specifically** and to report again at whatever severity if the defect is still there, exempt from any reporting bar; and findings a writer declined, which lanes are told to report again if still present, likewise exempt from any bar. When the caller sends round state, also pass the round number, the caller-computed touched-file set, and the caller's reporting bar for this round. The three lists must never be merged: telling a lane to skip a finding somebody claims to have fixed is how an unverified fix becomes an approval, and a declined finding is neither settled nor claimed fixed, so folding it into either list buries a live defect the writer refused to touch.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `code-review`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

**No changed-file set, no run. No routing flags, no run.** The script refuses an absent or empty `changedFiles` or non-boolean `codexAllowed` and `grokAllowed`, because an empty set drops every finding into a block that reads as clean, and missing flags could send a work diff to a forbidden CLI.

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
| `external` | Codex CLI | `gpt-5.6-sol`, effort `high` | Danger is HIGH and a lane slot is free |
| `tiebreak` | Grok CLI | default | Two lanes disagree on whether a specific finding is real. Runs during convergence inside the workflow, never during lane dispatch |

The trigger column is a copy of the rows `laneTriggerTable` renders from the `laneDefinitions` array in `~/.claude/workflows/qa-swarm.js`, which is the text the router prompt actually carries; edit a lane's `trigger` there first and copy the rendered row here. The script pins these models. `security` stays on fable because security judgment outranks cost.

Each run is capped at three lanes. Priority is `code`, forced `security`, router recommendations in their value order, then `external`; follow-up rounds use `code`, carried `security`, other carried owners in first-seen order, then carried `external`.

A follow-up round with touched files skips routing and reviews only those files plus files named by claimed-fixed and declined findings. Round 1 already swept everything else, so the narrower pass preserves regression and declined checks without paying for the whole diff again. A `REVIEW_CMD` that already carries a `-- <paths>` restriction is never narrowed further, because git unions pathspecs across two `--` groups instead of intersecting them, so that round keeps the full sweep and reports the fallback as a degradation note.

**CLI routing flags.** Read the profile `CLAUDE.md` `<routing>` rule yourself: a rule forbidding a CLI sets that CLI's flag false, and no such rule means both true. Never leave detection to a spawned agent, which is told routing does not bind it. Sending a work diff to a forbidden CLI is a confidentiality breach, not a routing preference. A false flag emits no instruction for that CLI and uses the substitute below:

| Lane | CLI route | False-flag substitute |
|---|---|---|
| router | Codex `gpt-5.6-terra` | `opus`, same prompt, when `codexAllowed` is false |
| `external` | Codex `gpt-5.6-sol` | `opus`, adversarially refuting the other lanes, when `codexAllowed` is false |
| `tiebreak` | Grok | `opus` with both positions only, when `grokAllowed` is false |

## Reviewer output format

Every lane, and this skill itself, ends its response with:

```
STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM> | reviewer: <tag> | body: <the review comment text>
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

Lanes report MEDIUM and above and never `NIT`. LOW remains accepted only as a parser safety net and is dropped before convergence.

## Step 1: Run the workflow

Build `args` from the caller's inputs, call `Workflow({name: 'qa-swarm', args})`, and relay its result verbatim. A result whose first line is `LANE_DEATH:` is the blocking lane death the caller must fail on. Pass `scriptPath: '~/.claude/workflows/qa-swarm.js'` instead of `name` only while iterating on the script inside one session; the `Read(~/.claude/workflows/**)` allow rule in settings.base.json is what lets the tool open it.

The workflow converges mechanically when no findings survive, or when one lane owns every survivor, no lane summary reports an overflow, and no lane explicitly says `verified safe`. Every lane definition requires those two words verbatim in the summary whenever the lane checked a suspected defect and cleared it, which is what makes the tiebreak path reachable. A needed convergence agent gets one retry with its exact validation failure before judgment is declared dead. Its retry prompt carries a per-run id, so `resumeFromRunId` re-runs a dead retry rather than replaying its cached output.

Workflow tool absent in this session: read `~/.claude/workflows/qa-swarm.js`, spawn the lane set it names in one message with multiple calls, as before, and converge by the rules in that script.

## Step 2: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step. The caller decides what any of it means.

The summary paragraph says: how many findings survived convergence, which lanes ran and which were skipped or degraded, the router's danger and complexity ratings or the follow-up routing note, the filter counts, and the lanes that hit their own cap, written as the fixed phrase `truncated lanes: <comma-separated lane tags or none>`. Those are facts the caller needs and cannot recover. That one phrase is worded verbatim, always present, and `none` when nothing capped, because the caller parses it rather than reads it.

## Token discipline

- Round 1 has a router pass plus one `code` lane. Follow-up rounds with touched files skip the router. Every extra lane is another full pass, and `security` runs on fable, the priciest tier.
- Never paste diff text into a prompt. Hand over `REVIEW_CMD` and let the lane run git itself.
- Diffs over roughly 2000 changed lines: tell each lane to prioritize by risk within its scope. Do not answer size by adding lanes.
- The router exists to keep lanes off work they do not need. A plan that delegates everything every time means the router prompt is wrong.
