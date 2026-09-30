---
name: commit
description: Personal commit workflow. Reviews and fixes in a loop via /code-review, then runs two deterministic steps (preflight, land) that stage, commit, and push with typed outcomes, then promote the feature branch onto the resolved mainline or leave it pushed for /open-pr, per the machine's commit policy. Use for /commit, "commit this", "commit and push", or landing finished work.
---

# Commit

Two deterministic steps own everything that touches git. You own the review loop, the
commit message, and the recovery procedures. Never stage, commit, push, or merge by hand
outside the recovery sections below.

```
node "$HOME/.claude/skills/commit/preflight.ts" [--paths <file-or-dir> ...] [--no-fetch]
node "$HOME/.claude/skills/commit/land.ts" [--paths ...] [--promote] [--no-push] <<'MSG'
<commit message>
MSG
```

Both print one JSON object on stdout and set the exit code from the outcome table. `node`
must be 22.18 or newer; it runs the TypeScript directly, with no build step.

## Step 1: preflight

Run `preflight.ts` first, with `--paths` when you know exactly which files this session
changed.
Use preflight's `paths` output as the scoped file list for `ai-slop-cleaner`, `/code-review`,
and `land.ts`.

It answers six things: the outcome (`READY` or a refusal), the current `branch` and
whether `branchAllowed` permits committing on it, the `changed` and `untracked` files that
will be staged, the machine's `policy`, `mainlineFreshness`, and `remoteVisibility`, which
**Step 3.5: disclosure check** reads.

**Branch guard.** `branchAllowed: false` means the profile or resolved mainline forbids
committing on this branch. `policy.commitBranches.onForbidden` permits only
`create-feature-branch`: create
a branch named for the work item, switch to it, and proceed.

**Mainline freshness.** A `mainlineFreshness.behind` above zero means rebase onto
`origin/<mainline>` now, before Step 2, then re-run preflight. A conflict there uses the
Conflict resolution section and needs no re-review, since nothing has been reviewed yet.
`checked: false` with a `reason` means freshness is unknown; proceed. `--no-fetch` skips this check and omits `mainlineFreshness`; promotion re-verifies when origin exists and refuses failed fetches or a missing remote mainline with `MAINLINE_UNVERIFIED`.

An unresolved mainline warns; landing pushes the feature branch without promotion.

**No policy.** A missing `policy` field (the warning names the reason) means the machine
profile has not been applied. `main` and `master` are still guarded, so `branchAllowed`
still answers the branch question. Do not promote: run `land.ts` without `--promote` and
tell the carbon unit to run `~/.dotfiles/script/bootstrap --profile <name>` from the main checkout.

## Step 2: review loop

Nothing rewrites the code between the last review and the commit, so the review is the
gate.

**Skip the loop** for a mechanical follow-up with passing tests: a pure rename, or a
reviewer's suggestion applied verbatim. A review there costs minutes and finds nothing. Go
straight to **Step 3: write the message**. Any logic change, however small, runs the loop.

**Step 0, once.** Run `ai-slop-cleaner` on preflight's `paths` as its file list, identifying `/commit` as the caller.

**Then loop.**

1. Invoke `/code-review` with target `working`, the repo path, preflight's `paths`
   as `--paths`, and one or two sentences of what changed and the goal
   it serves. Always `working`, never `staged`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Read its header lines — `VERDICT`, `ACTIONABLE`, `TRUNCATED` — and act:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; never treat a failed review as a passed one.
   - Any `AMBIGUOUS` finding at MEDIUM or higher on round 1 or 2, at any verdict: stop and
     put it to the carbon unit with both readings stated. Carry the answer into the next `/code-review`
     call as a stated decision so the finding is re-dispositioned; an `AMBIGUOUS` finding
     that survives an answer means the answer never reached the next round. Report lower
     severity `AMBIGUOUS` findings without interrupting.
   - `ACTIONABLE` at MEDIUM or higher on round 1 or 2: hand exactly those findings
     plus the changed-file list to the `finding-fixer` agent in a single spawn, and state
     that `Scope:` is that list, `Out of scope:` is pre-existing issues outside it, and
     `Definition of done:` is its finding-fixer receipt. Then go back to step 1. LOW findings are
     listed in the commit report and left alone.
   - Round 3 never asks and never stops, whatever the verdict, FAILED excepted: a failed
     review keeps its own rule on every round, so a round-3 `VERDICT: FAILED` re-runs once
     and then stops rather than landing a review that never completed. Hand every surviving
     `ACTIONABLE` finding at MEDIUM or higher to `finding-fixer` the same way. Decide each
     surviving `AMBIGUOUS` finding at MEDIUM or higher yourself, from the caller context and
     the code: one tagged `necessity`, `necessity/unasked`, or any necessity category other
     than `necessity/dead` and `necessity/redundant-test`, carrying no answer from the carbon
     unit, is never re-dispositioned `ACTIONABLE` and is recorded as a NIT with the reading
     you chose, because cutting work that may have been wanted is the carbon unit's call and
     round 3 has nobody to ask; one tagged `necessity/dead` or `necessity/redundant-test`
     is recorded as a NIT the same way, since a mechanical cut still `AMBIGUOUS` this late
     carries either `Confidence: low` or a writer's `DECLINED` receipt, and round 3 can
     neither re-run the evidence that would clear the first nor overrule the refusal behind
     the second; any other one with a bounded fix inside the changed-file list is
     re-dispositioned `ACTIONABLE`, with the
     reading you chose written into its body, before it joins the writer's batch, since a
     finding still marked `AMBIGUOUS` when it arrives is declined on sight; a MEDIUM one
     without such a fix is recorded as a NIT with the reading you chose;
     and a HIGH or CRITICAL one without such a fix is recorded with its reading in the commit
     message body. When the receipt is back, go to **Step 3: write the message**; no fourth
     review runs. Every finding that receipt marks `FIXED` goes in the message's `Not-tested`
     trailer, because the last review never saw those edits, and `Confidence` cannot be
     `high` while that trailer names one. A receipt that never arrives, does not parse, or
     omits a finding it was handed counts every finding missing from it as `DECLINED`, and
     puts every change to the tree since that dispatch in the `Not-tested` trailer, because a
     spawn that died mid-edit leaves work no review and no receipt accounts for. `DECLINED`
     findings and the `AMBIGUOUS` calls you made go in the commit report.
   - Round 3 always commits, FAILED excepted, and what it withholds instead is promotion.
     A HIGH or CRITICAL finding it never got verified fixed — `DECLINED` by the writer,
     handed over but absent from the receipt, `AMBIGUOUS` and recorded rather than fixed,
     or claimed `FIXED` with no review after it, which is every HIGH or CRITICAL finding the
     `Not-tested` trailer names — means running `land.ts` without `--promote`, so the
     feature branch is pushed and mainline is untouched, and naming each such finding in the
     commit message body, so the decision is visible in history rather than only in the chat
     report. The commit and its trailer stay as written either way. Where
     `policy.afterCommit` is `promote`, say in the report that a later plain re-run with
     `--promote` carries the commit onto mainline once a carbon unit has looked at those
     findings; under any other policy **Step 4: land** already omits the flag, so the round
     lands exactly as that step says and nothing is withheld.
   - No `ACTIONABLE` finding at MEDIUM or higher, with a verdict of `APPROVE` or `APPROVE WITH NITS`: leave the loop.
3. At most **three** rounds, and the third always ends in **Step 3: write the message**,
   FAILED excepted. Three sweeps have had their look; a fourth costs more than the
   unverified edit it would catch, and a stop here only hands the carbon unit the same
   decision this loop just made.

The loop exits when no `ACTIONABLE` finding of MEDIUM or higher remains, not on the
verdict: a MEDIUM finding dispositioned `ACTIONABLE` is a verified defect with a bounded
fix and still maps to a passing verdict. LOW never triggers another round.

Carry three separate lists into the next `/code-review` call, never merged: the findings
settled as `NIT` or `AMBIGUOUS`, the receipt's `FIXED` findings, and the receipt's
`DECLINED` ones. A round 1 or 2 where `finding-fixer` declines every finding it was handed is
a stop, not a retry; on round 3 it lands, since the tree the last review saw is unchanged,
and lands without promotion when any of those declined findings is HIGH or CRITICAL.

Also carry, verbatim, the round number, the pin round 1's `/code-review` summary reported,
and the previous round's `TRUNCATED` line, even when it says `none`. Count the first
`/code-review` call as round 1 and increment after each `finding-fixer` dispatch.

**A merge you resolve by hand invalidates the review of the branch it lands on.** A clean
merge is not a safe merge: integration can change a helper in one file while the reviewed
change adds its caller in another. Where the recovery sections say **re-review**, they mean
steps 1 and 2 of this loop only.

One carve-out, and only one: merging `origin/<branch>` into the same local branch needs no
re-review, because whatever is on the remote was reviewed by whoever landed it. Every other
merge, a feature branch into an integration branch included, is a combination nothing has
looked at.

## Step 3: write the message

You write the message; nothing generates it for you. The convention:

```
<type>(<scope>): <description>

Body paragraph explaining the why.

Constraint: ...
Rejected: ...
Directive: ...
Confidence: high|medium|low
Scope-risk: narrow|moderate|broad
Not-tested: ...
```

`type` is one of feat, fix, refactor, chore, docs, test, style, perf, build, ci.
`description` is one line, 72 characters or fewer, no trailing period. Trailers are
optional as a block, but a message that carries any trailer must carry `Confidence` and
must carry `Scope-risk`; `Constraint`, `Rejected`, `Directive`, and `Not-tested` are
included only when they apply. Omit the whole trailer block only for a genuinely trivial change (a
version bump with no logic change).

Check a draft before landing with `node "$HOME/.claude/skills/commit/preflight.ts"
--check-message` and the message on stdin; success returns `READY`. `land.ts` runs the same validation and refuses
with `MESSAGE_INVALID` rather than committing something malformed.

## Step 3.5: disclosure check

Many work repos are public, and a push publishes the diff and message to everyone. Before
landing, decide whether everything the landing would publish should reach the remote at
all: the working changes plus every local commit not yet on the remote, read with
`git log -p @{upstream}..HEAD`, or `git log -p origin/<mainline>..HEAD` when the branch has
no upstream. An earlier held-back commit among them holds back this landing too. Treat
`remoteVisibility.visibility` of `public` or `unknown` as public; `private` and `internal`
are not.

On a public remote, these must not be pushed:

- A fix for an exploitable vulnerability that has not been disclosed, its regression test,
  or a message describing the attack. The diff alone shows attackers what was open.
- Credentials, customer names or data, PII, internal hostnames, or incident details.

When the change carries any of them, run `land.ts` with `--no-push` and without
`--promote`, so the commit stays local, then stop and tell the carbon unit what you found.
A vulnerability fix goes through the repo's private channel instead: a GitHub security
advisory's temporary private fork, or whatever the repo's `SECURITY.md` names. Strip a
secret or customer detail out of the tree instead, then re-review; one that already
reached a remote needs rotating, not just deleting.

Everything else lands normally. On a public remote, still write the message as public
text: name the defect class, never the exploit steps or the customer.

## Step 4: land

Pipe the message into `land.ts` with a quoted heredoc, so nothing in the message is
expanded by the shell:

```
node "$HOME/.claude/skills/commit/land.ts" --promote --paths src/thing.ts <<'MSG'
feat(thing): do the thing

Why it was done this way.

Confidence: high
Scope-risk: narrow
MSG
```

Flags:

- `--paths <file-or-dir> ...`: pass preflight's `paths`, as used for `/code-review`.
  Omit it only when the carbon unit asked to commit everything or you cannot enumerate what
  changed. Report `excluded staged files outside --paths: ...` warnings to the carbon unit;
  those files were unstaged and remain in the working tree. A denylisted addition still in
  the index after exclusion stops the run with `DENYLISTED_FILE_STAGED`.
- `--promote`: pass it when `policy.afterCommit` is `promote`. It carries the commit
  by rebasing the feature branch onto `policy.resolved.mainline`, fast-forwarding
  mainline, and pushing mainline. When origin has the mainline but no local branch, it
  materializes a local tracking branch from `origin/<mainline>` first. Omit it when the
  disclosure check held the change back, when the user asked for commit-only ("commit
  only", "don't merge"), when `policy.afterCommit` is `pull-request`, or when there is no
  policy.
- `--no-push`: only when the user asks for local-only work or the disclosure check held
  the change back. It suppresses every push, including feature, mainline, safety, and
  remote branch deletion pushes. Promotion may
  still update local mainline; `warnings` names a locally promoted mainline left unpushed.

## Outcomes

Exit code carries the outcome; the JSON carries the detail. Report one line with the
outcome, short hash, and message subject, then one line per finding fixed. Expand only on
failures.

| Outcome | Exit | What to do |
|---|---|---|
| `COMMITTED` | 0 | Report the commit and any branches listed in `promoted` |
| `NOTHING_TO_COMMIT` | 13 | With `--promote`, promotion still ran: report what `promoted` says. Without it, stop and relay |
| `MESSAGE_INVALID` | 20 | `errors` names each violation. Fix the message and re-run `land.ts` |
| `HOOK_FAILED` | 21 | A commit hook rejected the commit, or git could not stage a scoped file or unstage an out-of-scope one; git's stderr is in `warnings` and nothing was committed. Fix the cause, then re-run |
| `DENYLISTED_FILE_STAGED` | 25 | The index would add a file the denylist names (`.env*`, `*.log`, `node_modules/`, `dist/`, `__pycache__/`); `files` lists them and nothing was committed. Unstage each one (`git restore --staged <file>`) and re-run, or put it to the user when it genuinely belongs in the commit |
| `PUSH_FAILED` | 22 | The commit exists, the push did not land. Recover below |
| `PROMOTE_CONFLICT` | 23 | The commit exists. A conflicted feature rebase was aborted and `conflicts` names the files, or an empty list means mainline diverged from origin. Resolve below |
| `PROMOTE_FAILED` | 24 | The commit exists; promotion stopped for a non-conflict reason named in `warnings`, and `promoted` says which branches did update. Recover below |
| `MAINLINE_AHEAD` | 26 | Local mainline has commits absent from origin. `localOnlyCommits` lists their SHAs. Push or drop them by hand, then re-run; the skill never publishes them implicitly |
| `POLICY_INVALID` | 27 | The applied profile uses unsupported commit policy vocabulary. Update the profile file named in `errors`, then re-run preflight |
| `BRANCH_FORBIDDEN` | 28 | `land.ts` was invoked on the guarded `branch` and wrote nothing. Create and switch to a feature branch, then re-run preflight |
| `MAINLINE_UNVERIFIED` | 29 | Origin exists, but fetch failed or `origin/<mainline>` is missing, so promotion refused. `warnings` carries the verification detail. Restore remote verification, then re-run |
| `NOT_A_REPO` | 10 | Stop and relay |
| `DETACHED_HEAD` | 11 | Stop and relay |
| `OPERATION_IN_PROGRESS` | 12 | A merge, rebase, or cherry-pick is in flight (`operation`). Stop and relay |

`pushed: false` after successful mainline promotion is normal. Report safety-push failures
from `warnings`; they do not change the outcome.

## Conflict resolution

`PROMOTE_CONFLICT` with files in `conflicts` is yours to resolve; do not dead-end on it.
The rebase is already aborted, so the tree is clean.

1. On the feature branch, fetch origin and rebase onto `policy.resolved.mainline`.
2. Resolve each conflicted file on its merits: read both sides, keep both intents where
   they are independent, and pick the semantically correct result where they collide. Never
   resolve by blanket `--ours`/`--theirs`, and never drop changes you cannot account for.
3. Stage the resolutions and continue the rebase.
4. Re-review the rewritten feature range before it reaches mainline.
5. Re-run `land.ts` with the same flags so it finishes the fast-forward and push.
   `NOTHING_TO_COMMIT` there is expected.

An empty `conflicts` list means local mainline diverged from origin. Stop and put the
listed branch relationship to the carbon unit; the skill never merges, resets, rebases,
or force-pushes a diverged mainline.

Stop and report instead when the same hop conflicts again after two attempts, a conflict
involves changes you cannot attribute, or resolving would mean discarding one side
wholesale.

## Push and promote recovery

A SessionStart `Parked branches:` entry is an unfinished landing from `~/.claude/commit-ledger.jsonl` (or the absolute `CLAUDE_COMMIT_LEDGER` override).
Return to the listed branch, rerun preflight, follow the outcome's recovery instructions, then rerun `land.ts` with the original flags, which retries a failed push.

`PUSH_FAILED` and `PROMOTE_FAILED` are yours to resolve the same way. `warnings` names the
root cause. Fix it, then re-run `land.ts` with the original flags, which retries the push; a
`NOTHING_TO_COMMIT` outcome on the re-run is expected. These git commands are sanctioned
only to unblock the run.

- Mainline push rejected (non-fast-forward, "stale info", "fetch first"): the remote moved
  after preflight. The feature branch safety push preserves the work. Resolve local
  mainline against origin by hand without force, then re-run from the feature branch.
- Feature push rejected: fetch and merge `origin/<branch>` into the same local feature
  branch, push it, then re-run. A conflict resolved by hand requires re-review first.
- A destination branch checked out in a dirty worktree: if the uncommitted changes are this
  session's, land them by running this whole workflow in that worktree, review loop
  included. Never commit them by hand to clear the way. Changes you cannot attribute are a
  stop case.
- Transient network or remote errors: re-run once before treating the failure as real.

Stop and report only when the failure is authentication, permissions, or branch protection;
when the same failure survives two recovery passes; or when fixing would mean touching
changes you cannot attribute.

## After the commit

Read `policy.afterCommit`:

- `promote`: promotion already ran inside `land.ts`. Mainline receives the rebased feature
  branch by fast-forward. Never merge branches
  yourself (sole exception: the recovery above), even when asked to "just merge it
  quickly"; re-run `land.ts` instead. A clean tree with `--promote` still promotes an
  unlanded feature tip.
- `pull-request`: never merge the feature branch anywhere. When the disclosure check held
  the change back, stop after reporting; a public pull request discloses it too. Otherwise
  offer to open a pull request against the repository's mainline with `/open-pr`. If the
  carbon unit declines, stop after reporting. `/pr-review` reviews a pull request only when asked for by name.
