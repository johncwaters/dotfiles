---
name: code-review
description: Internal review engine. Pins a diff to an immutable object, calls qa-swarm to find defects, gives every finding one disposition, and returns a verdict plus a dispositioned findings block. Strictly read-only, so it never edits a file, never touches git history, never posts anywhere, and never re-runs itself. Invoked by /commit and /pr-review, never as a direct entry point.
---

# Code Review

One pass. Pin, find, triage, judge, return. Every cycle in the review ladder lives one layer above this skill.

## Contract with the caller

**Required input.** A target, in one of three forms: `staged`, `working` (a local tree), or a base and head ref (a branch or a pull request); the changed-file set as `-- <paths>`; and 2 to 4 sentences of context that the diff does not carry. If the caller omits paths, derive the set with `git diff --name-only` from the target diff and state the derived set in the output.

**Optional input.** The previous round's findings block plus the writer's receipt, so this pass can tell settled ground from ground that was supposedly repaired; that round's `TRUNCATED` line; and the round number plus the round-1 pin, meaning the tree SHA or `base..head` range the first round's summary reported. The round number counts `/commit` writer rounds only: the first call is round 1, the call after the first `finding-fixer` dispatch is round 2. The writer-touched set is never self-reported: this pass computes it as `git diff --name-only <round-1 pin> <this round's pin>` restricted to the changed-file set, which is mechanical, immune to a writer misspelling or omitting a path, and cumulative across every writer round so far, so a round-3 rediscovery of a round-1 defect is not mistaken for late. The late-finding rule is armed only when the round number, the resolved round-1 pin, and the previous round's `TRUNCATED` line are all present. Round 1 carries no such line because it has no previous round. Missing rule inputs disarm only the reporting bar; a resolved round-1 pin still supplies the touched-file state that narrows follow-up review.

**Guaranteed output.** A `VERDICT` line, an `ACTIONABLE` line, a `TRUNCATED` line, one `STRUCTURED_FINDINGS` block carrying a `disposition` field per finding, and one `OVERALL_SUMMARY`. Nothing after them.

**Never.** No file edits. No `git add`, `commit`, `push`, or branch operations. No PR comments (that is `/pr-review`). No second round: this skill has no opinion about whether it should run again, and a caller that wants another pass invokes it again with the previous findings in hand.

**Not a direct entry point.** Asked to review something conversationally, route it: local work goes through `/commit`, a pull request goes through `/pr-review`. Both call this skill with a proper target.

## Step 1: Pin the target

Pin to an immutable object, never a live tree. `qa-swarm` runs lanes concurrently for minutes, and `git diff --cached` re-reads the index on every call, so an edit or a `git add` mid-review silently hands later lanes a different diff.

- **staged**: `TREE=$(git write-tree)`, then `REVIEW_CMD="git diff HEAD $TREE"`. `write-tree` freezes the current index as a tree object without touching the index, the refs, or the stash stack

- **working**: snapshot through a throwaway index so the live one is never mutated. Never `git add -A` against the real index to set up a review; that stages whatever the carbon unit deliberately left unstaged, and the next commit quietly carries it

```
TMP_DIR=$(mktemp -d)
cp "$(git rev-parse --git-dir)/index" "$TMP_DIR/index"
GIT_INDEX_FILE="$TMP_DIR/index" git add -A
TREE=$(GIT_INDEX_FILE="$TMP_DIR/index" git write-tree)
rm -rf "$TMP_DIR"
REVIEW_CMD="git diff HEAD $TREE"
```

`mktemp -d` and not `mktemp -u`: the `-u` form only reserves a name, so another local process can land a symlink there first and have the `cp` overwrite its target.

- **branch or pull request**: resolve `BASE_SHA` and `HEAD_SHA`, then `REVIEW_CMD="git diff <BASE_SHA>..<HEAD_SHA>"`. Both are already immutable

Record the changed-file set, file count, changed-line count, and touched subsystems. Report the pin and changed-file set in the summary so the caller can prove which tree and files were judged.

## Step 2: Call qa-swarm

Invoke `/qa-swarm` with the pinned `REVIEW_CMD`, the repo path, the caller's context verbatim, the changed-file set, the profile-derived `codexAllowed` flag, and every piece of carried state named separately, never collapsed into one "already dispositioned" list: the findings settled as `NIT` or `AMBIGUOUS`, which lanes must not re-report; the findings the writer's receipt claims `FIXED`, as regression checks; and the findings the writer `DECLINED`, which lanes report if still present.

On every round 2 or later where the round-1 pin resolves, add the round number and the touched-file set computed from that pin and this round's pin. Forward the late-finding rule as `reportingBar` when armed and `reportingBar: "none"` when disarmed. The file state always goes forward because `qa-swarm` uses it to narrow follow-up review independently of the reporting bar.

Do not spawn a reviewer agent directly from here. All finding goes through `qa-swarm`, so there is exactly one place that knows which lanes exist and when they trigger.

`qa-swarm` reporting a blocking lane death is a failed review. Return `VERDICT: FAILED` with whatever findings did arrive and a summary naming the dead lane. Never fall through to APPROVE on a dead lane, and never omit the `VERDICT` line: a caller parsing for it would hang or guess.

## Step 3: Triage

Every finding leaves this step with exactly one disposition. A finding with none is a bug in the run, not an acceptable outcome.

Before applying severity rules, remove any finding whose `file` is outside the changed-file set, or whose line is untouched by the diff and describes a pre-existing defect. The scope hook's PostToolUse note on each lane result names both kinds mechanically, as `outside the current diff` and `lines the diff did not change`; a finding it names survives only when its body attributes the defect to a changed line. That note is authoritative only for a `working` target, where the hook's HEAD-versus-tree diff is the pinned diff. A `staged` target pins `git write-tree` of the index while the hook keeps diffing the live tree, so an unstaged edit above a staged defect shifts its line and the note calls a correct finding unchanged; a branch or pull request target describes the wrong tree outright, and a clean checkout leaves the note naming every finding file. Ignore it entirely for both and apply the prose rule above on its own. Mention all such removals in at most one sentence in `OVERALL_SUMMARY`, never in `STRUCTURED_FINDINGS`. Severity does not rescue an out-of-scope finding. Then keep at most 10 findings per lane, highest severity first, and set the `TRUNCATED` line of the return to the union of the lanes `qa-swarm`'s `truncated lanes:` phrase names and the lanes this cap dropped findings from, so the next round can tell a swept diff from a capped one. The union is what makes the line true: every agent lane caps itself at 10 before its findings reach here, so this cap firing on those lanes is the rare case, and reading `TRUNCATED` off it alone reports `none` for the swarm's own overflow.

| Disposition | Assign when | What the caller does with it |
|---|---|---|
| `ACTIONABLE` | The defect is clear, the fix is bounded, and the finding was verified against real code | Hands it to a writer. The only disposition a writer ever sees |
| `NIT` | Style, preference, a duplicate of another finding, or plainly out of the change's scope | Records it. Never fixed, never blocks |
| `AMBIGUOUS` | Contested between lanes, cross-cutting enough that the fix is a design decision, or the intent behind the code is unclear | Stops and asks the carbon unit, with both readings stated |

Rules that decide the hard cases:

- A finding whose `body` carries `Confidence: low` is never `ACTIONABLE`. It is `AMBIGUOUS` if it would block, `NIT` if it would not.
- A `convergent:` finding is `ACTIONABLE` if its fix is bounded, even when one contributing lane was low-confidence. Independent agreement is what clears the confidence bar.
- A CRITICAL or HIGH finding is never `NIT`. If it cannot be `ACTIONABLE`, it is `AMBIGUOUS`.
- Lanes no longer report LOW. A LOW finding that survives as a straggler is recorded as `NIT`, never `ACTIONABLE`, and never triggers another review round. A CRITICAL finding needing an architecture call is `AMBIGUOUS`.
- A finding tagged `necessity/dead` or `necessity/redundant-test` at MEDIUM whose body carries the mechanical evidence its category demands — the zero-hit grep naming both the pattern and the paths searched, plus the statement that the goal mandates no such artifact and that no convention or glob loader picks it up unnamed, or the existing test named by file and test name with its assertion quoted and the input or branch that assertion runs on named — is `ACTIONABLE`. The cut is obvious, the writer can re-run that evidence before deleting anything, and stopping to ask the carbon unit about a symbol nothing calls or a test that duplicates one already passing is noise. The low-confidence rule wins over this one, so a finding in either category whose body carries `Confidence: low` is `AMBIGUOUS`. One whose body carries no such evidence has not earned its tag and is treated as `necessity/unasked` under the bullet below.
- A finding tagged `necessity`, `necessity/unasked`, or any necessity category other than the two above, at MEDIUM and carrying no answer from the carbon unit, is always `AMBIGUOUS`, never `ACTIONABLE`. It asks for a deletion no later round can verify, and whether the work was wanted is the carbon unit's call. One the caller answered follows the carried-in rule below instead, re-dispositioned by that answer. The late-finding rule still wins over every necessity category, so a late `necessity` MEDIUM is `NIT`. The low-confidence rule changes nothing here, since `AMBIGUOUS` is already the outcome.
- A finding tagged `scale` or `scale/<category>`, or carrying a `convergent:` tag that names one, whose fix is a local rewrite inside the changed-file set — a keyed lookup, a single pass, a memo, or hoisting a query out of a loop — is `ACTIONABLE` at MEDIUM and above. One whose fix needs a schema, index, pagination contract, or data-model change is a design decision and is `AMBIGUOUS` at MEDIUM and above, with both readings stated. The convergent rule and the late-finding rule both win over this one, so a `convergent:` scale finding whose fix is a bounded local rewrite stays `ACTIONABLE` whatever its confidence, and a late scale MEDIUM is `NIT`. A scale finding carrying no `convergent:` tag and marked low-confidence is dispositioned by the low-confidence rule instead. A merged finding keeps its scale tag inside the `convergent:` tag, which is why this bullet reads it there rather than asking qa-swarm for the never-merge exemption the `necessity` lane has.
- **Late-finding rule, round 2 and later.** A first-time finding — one matching nothing in the previous round's block, the only block this pass is given — whose `file` is outside the computed touched-file set is late. That round swept the whole diff; a late finding is this round's lane noticing what last round's lane missed by chance, not new work to verify, and without this rule the loop re-litigates settled ground forever. Late at MEDIUM or LOW: `NIT`, named as late in its body. HIGH and CRITICAL are exempt and follow the normal rules whatever the round. Two things are never late: a finding in a writer-touched file, since the writer's edits are fresh surface; and a finding whose body attributes the defect to a change in a writer-touched file, wherever it sits, since a fix that breaks a caller elsewhere is new work. A previous round whose `TRUNCATED` line named any lane disarms this rule for the whole of this round, since the overflow it dropped never got its first look.

Carried-in findings are handled by disposition, not uniformly:

A carried finding that returns under another lane's tag and names its original tag in the body is the same finding, matched on file, line, and body rather than tag.

- Previously `NIT`: suppressed. It keeps that disposition unless the new round raises its severity.
- Previously `AMBIGUOUS`, with no answer from the carbon unit: suppressed, still `AMBIGUOUS`. Asking twice for the same answer is noise.
- Previously `AMBIGUOUS`, with an answer supplied by the caller: **re-dispositioned by the answer**, `ACTIONABLE` when the answer says fix it, `NIT` when the answer says leave it. `AMBIGUOUS` is the only disposition with no way out of its own accord, so a caller that supplies an answer must see it consumed; leaving it `AMBIGUOUS` makes the caller's loop ask forever.
- Previously `ACTIONABLE`, whatever the writer's receipt says: **never suppressed**. A `FIXED` receipt is a claim, not a verification, and this pass is the verification. If the same finding comes back, the fix did not work, and it stays `ACTIONABLE` with that fact in its body. A `DECLINED` receipt makes it `AMBIGUOUS`, because the writer already refused it once and a second identical attempt will refuse again.

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

`VERDICT` and `ACTIONABLE` come first so a caller can gate on two lines without parsing the block. A looping caller gates on `ACTIONABLE`; a landing caller gates on `VERDICT`; both are needed because they can disagree. `TRUNCATED` names every lane whose findings a cap dropped, its own or the lane's, or `none`, and it is machine-readable rather than a summary sentence because the caller must carry it into the next round, where it disarms the late-finding rule.

The summary states: the pinned tree or SHA range, changed-file set, file and line counts, which lanes ran and which degraded, the count per severity, and the count per disposition. Then stop. No recommendation about what to do next, and no offer to fix anything.

## Token discipline

This is the deliberately expensive layer, but expense should land on lanes rather than on this skill's own reasoning. Everything here is bookkeeping over a block `qa-swarm` already produced: pinning, one classification per finding, one table lookup. Re-reading the diff to second-guess a lane means the lane prompt was wrong.
