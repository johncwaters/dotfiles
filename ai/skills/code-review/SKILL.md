---
name: code-review
description: Internal review engine. Pins a diff to an immutable object, calls qa-swarm to find defects, gives every finding one disposition, and returns a verdict plus a dispositioned findings block. Strictly read-only, so it never edits a file, never touches git history, never posts anywhere, and never re-runs itself. Invoked by /commit and /pr-review, never as a direct entry point.
---

# Code Review

One pass. Pin, find, triage, judge, return. A change gets this pass once, so it reports what a lane proved broken and nothing a lane only suspected.

## Contract with the caller

**Required input.** A target, in one of three forms: `staged`, `working` (a local tree), or a base and head ref (a branch or a pull request); the changed-file set as `-- <paths>`; and 2 to 4 sentences of context that the diff does not carry. If the caller omits paths, derive the set with `git diff --name-only` from the target diff and state the derived set in the output.

**Guaranteed output.** A `VERDICT` line, an `ACTIONABLE` line, a `TRUNCATED` line, one `STRUCTURED_FINDINGS` block carrying a `disposition` field per finding, and one `OVERALL_SUMMARY`. Nothing after them.

**Never.** No file edits. No `git add`, `commit`, `push`, or branch operations. No PR comments (that is `/pr-review`). No second round: no caller carries findings from one pass into another, because a second sweep of the same diff turns up a fresh batch of MEDIUM findings every time and the loop never converges.

**Not a direct entry point.** Asked to review something conversationally, route it: local work goes through `/commit`, a pull request goes through `/pr-review`. Both call this skill with a proper target.

## Step 1: Pin the target

Pin to an immutable object, never a live tree. `qa-swarm` runs lanes concurrently for minutes, and `git diff --cached` re-reads the index on every call, so an edit or a `git add` mid-review silently hands later lanes a different diff.

- **staged**: `TREE=$(git write-tree)`, then `REVIEW_CMD="git diff HEAD $TREE"`. `write-tree` freezes the current index as a tree object without touching the index, the refs, or the stash stack

- **working**: snapshot through a throwaway index so the live one is never mutated. Never `git add -A` against the real index to set up a review; that stages whatever the carbon unit deliberately left unstaged, and the next commit quietly carries it

```
REVIEW_INDEX=$(mktemp)
cp "$(git rev-parse --git-dir)/index" "$REVIEW_INDEX"
GIT_INDEX_FILE="$REVIEW_INDEX" git add -A
TREE=$(GIT_INDEX_FILE="$REVIEW_INDEX" git write-tree)
rm -f "$REVIEW_INDEX"
REVIEW_CMD="git diff HEAD $TREE"
```

`mktemp` and not `mktemp -u`: the `-u` form only reserves a name, so another local process can land a symlink there first and have the `cp` overwrite its target. A file, not a directory, because the Safety Net denies `rm -rf` on a variable.

- **branch or pull request**: resolve `BASE_SHA` and `HEAD_SHA`, then `REVIEW_CMD="git diff <BASE_SHA>..<HEAD_SHA>"`. Both are already immutable

Record the changed-file set, file count, changed-line count, and touched subsystems. Report the pin and changed-file set in the summary so the caller can prove which tree and files were judged.

## Step 2: Call qa-swarm

Invoke `/qa-swarm` with the pinned `REVIEW_CMD`, the repo path, the caller's context verbatim, the changed-file set, and the profile-derived `codexAllowed` flag.

Do not spawn a reviewer agent directly from here. All finding goes through `qa-swarm`, so there is exactly one place that knows which lanes exist and when they trigger.

`qa-swarm` reporting a blocking lane death is a failed review. Return `VERDICT: FAILED` with whatever findings did arrive and a summary naming the dead lane. Never fall through to APPROVE on a dead lane, and never omit the `VERDICT` line: a caller parsing for it would hang or guess.

## Step 3: Triage

Every finding leaves this step with exactly one disposition. A finding with none is a bug in the run, not an acceptable outcome.

Before applying severity rules, remove any finding whose `file` is outside the changed-file set, or whose line is untouched by the diff and describes a pre-existing defect. The scope hook's PostToolUse note on each lane result names both kinds mechanically, as `outside the current diff` and `lines the diff did not change`; a finding it names survives only when its body attributes the defect to a changed line. That note is authoritative only for a `working` target, where the hook's HEAD-versus-tree diff is the pinned diff. A `staged` target pins `git write-tree` of the index while the hook keeps diffing the live tree, so an unstaged edit above a staged defect shifts its line and the note calls a correct finding unchanged; a branch or pull request target describes the wrong tree outright, and a clean checkout leaves the note naming every finding file. Ignore it entirely for both and apply the prose rule above on its own. Mention all such removals in at most one sentence in `OVERALL_SUMMARY`, never in `STRUCTURED_FINDINGS`. Severity does not rescue an out-of-scope finding. Then keep at most 10 findings per lane, highest severity first, and set the `TRUNCATED` line of the return to the union of the lanes `qa-swarm`'s `truncated lanes:` phrase names and the lanes this cap dropped findings from, so the caller can tell a swept diff from a capped one. The union is what makes the line true: every agent lane caps itself at 10 before its findings reach here, so this cap firing on those lanes is the rare case, and reading `TRUNCATED` off it alone reports `none` for the swarm's own overflow.

| Disposition | Assign when | What the caller does with it |
|---|---|---|
| `ACTIONABLE` | The body's `Proof:` is one the writer can run again (a command with the output it produced, or quoted lines with file:line), it shows the defect on a path the change's own callers, tests, or documented commands reach, and the fix is bounded | Hands it to a writer, who re-runs that proof before and after the edit. The only disposition a writer ever sees |
| `NIT` | Style, preference, a duplicate of another finding, plainly out of the change's scope, or a `Proof:` that is a scenario rather than a run or a quote | Records it. Never fixed, never blocks |
| `AMBIGUOUS` | Contested between lanes, cross-cutting enough that the fix is a design decision, or the intent behind the code is unclear | Stops and asks the carbon unit, with both readings stated |

Rules that decide the hard cases:

- `qa-swarm` drops every row without a `Proof:` label, so the label's presence is settled before triage and its content is what triage reads. A proof that narrates what a caller could do, with no command output and no quoted lines, is a `NIT` below HIGH and `AMBIGUOUS` at HIGH or CRITICAL: the writer has nothing to re-run, and through 2026-10-12 triage was passing nearly every finding as `ACTIONABLE` while few bodies showed anything had been run.
- A finding whose `body` carries `Confidence: low` is never `ACTIONABLE`. Only a `contested:` merge carries it now. It is `AMBIGUOUS` if it would block, `NIT` if it would not.
- A `convergent:` finding is `ACTIONABLE` if its fix is bounded and one of its parts carries a re-runnable proof. Agreement between lanes confirms a proof and never stands in for one.
- A CRITICAL or HIGH finding is never `NIT`. If it cannot be `ACTIONABLE`, it is `AMBIGUOUS`.
- Lanes no longer report LOW. A LOW finding that survives as a straggler is recorded as `NIT`, never `ACTIONABLE`. A CRITICAL finding needing an architecture call is `AMBIGUOUS`.
- A finding tagged `necessity/dead` or `necessity/redundant-test` at MEDIUM whose body carries the mechanical evidence its category demands — the zero-hit grep naming both the pattern and the paths searched, plus the statement that the goal mandates no such artifact and that no convention or glob loader picks it up unnamed, or the existing test named by file and test name with its assertion quoted and the input or branch that assertion runs on named — is `ACTIONABLE`. The cut is obvious, the writer can re-run that evidence before deleting anything, and stopping to ask the carbon unit about a symbol nothing calls or a test that duplicates one already passing is noise. One whose body carries no such evidence has not earned its tag and is treated as `necessity/unasked` under the bullet below.
- A finding tagged `necessity`, `necessity/unasked`, or any necessity category other than the two above, at MEDIUM is always `AMBIGUOUS`, never `ACTIONABLE`. It asks for a deletion nothing afterwards can verify, and whether the work was wanted is the carbon unit's call.
- A finding tagged `code/scale`, or carrying a `convergent:` tag that names it, whose fix is a local rewrite inside the changed-file set — a keyed lookup, a single pass, a memo, or hoisting a query out of a loop — is `ACTIONABLE` at MEDIUM and above. One whose fix needs a schema, index, pagination contract, or data-model change is a design decision and is `AMBIGUOUS` at MEDIUM and above, with both readings stated.

## Step 4: Verdict

The tier is the highest severity still standing after triage and dedup:

| Highest severity | Verdict |
|---|---|
| CRITICAL | `BLOCKED` |
| HIGH | `REQUEST CHANGES` |
| MEDIUM | `APPROVE WITH NITS` |
| LOW or nothing | `APPROVE` |

Highest-severity-wins rather than a count-weighted score, because CRITICAL and HIGH block outright; a scheme where two HIGH findings block and one does not would contradict that. Counts go in the summary, where they inform without moving the gate.

A fifth value, `FAILED`, means the review could not be completed: `qa-swarm` reported a blocking lane death, or the target could not be pinned. It is not a judgement about the code and never means APPROVE. A caller treats it exactly as it treats `BLOCKED`, except that re-running is worth trying once because the cause is usually a dead process rather than a defect.

State the verdict and the count of surviving `ACTIONABLE` findings at MEDIUM or higher on separate lines in the summary.

## Step 5: Return

```
VERDICT: <APPROVE|APPROVE WITH NITS|REQUEST CHANGES|BLOCKED|FAILED>
ACTIONABLE: <count>
TRUNCATED: <lane list or "none">

STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM|LOW> | reviewer: <tag> | disposition: <ACTIONABLE|NIT|AMBIGUOUS> | body: <the review comment text>

OVERALL_SUMMARY:
<one paragraph>
```

Nothing found:

```
VERDICT: APPROVE
ACTIONABLE: 0
TRUNCATED: none

STRUCTURED_FINDINGS:
(none)

OVERALL_SUMMARY:
<one paragraph>
```

`VERDICT` and `ACTIONABLE` come first so a caller can gate on two lines without parsing the block. A looping caller gates on `ACTIONABLE`; a landing caller gates on `VERDICT`; both are needed because they can disagree. `TRUNCATED` names every lane whose findings a cap dropped, its own or the lane's, or `none`, and it is machine-readable rather than a summary sentence because the caller reports it: nothing afterwards sweeps for the overflow a cap dropped.

The summary states: the pinned tree or SHA range, changed-file set, file and line counts, which lanes ran and which degraded, the count per severity, the count per disposition, and `qa-swarm`'s `Dropped unproven` count. Then stop. No recommendation about what to do next, and no offer to fix anything.

## Token discipline

This is the deliberately expensive layer, but expense should land on lanes rather than on this skill's own reasoning. Everything here is bookkeeping over a block `qa-swarm` already produced: pinning, one classification per finding, one table lookup. Re-reading the diff to second-guess a lane means the lane prompt was wrong.
