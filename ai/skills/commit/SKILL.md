---
name: commit
description: Personal commit workflow. Reviews once via /code-review, fixes what that review proved broken, then runs two deterministic steps (preflight, land) that stage, commit, and push with typed outcomes, then promote the feature branch onto the resolved mainline or leave it pushed for /open-pr, per the machine's commit policy. Use for /commit, "commit this", "commit and push", or landing finished work.
---

# Commit

Two deterministic steps own everything that touches git. You own the review step, the
commit message, and the recovery procedures. Never stage, commit, push, or merge by hand
outside the recovery sections below.

```
node "$HOME/.claude/skills/commit/preflight.ts" [--paths <file-or-dir> ...] [--no-fetch]
node "$HOME/.claude/skills/commit/land.ts" [--paths ...] [--promote] [--no-push] <<'MSG'
<commit message>
MSG
```

Both print one JSON object on stdout and set the exit code from the outcome table.

## Step 1: preflight

Run `preflight.ts` first, with `--paths` when you know exactly which files this session
changed.
Use preflight's `paths` output as the scoped file list for `ai-slop-cleaner`, `/code-review`,
and `land.ts`.

**Branch guard.** `branchAllowed: false` means the profile or resolved mainline forbids
committing on this branch. `policy.commitBranches.onForbidden` permits only
`create-feature-branch`: create
a branch named for the work item, switch to it, and proceed.

**Mainline freshness.** A `mainlineFreshness.behind` above zero means integrate
`origin/<mainline>` with the verb the warning names before Step 2, then re-run preflight.
Merge only for `afterCommit: pull-request` with an upstream, since rebasing a pushed
branch needs a force-push; a landing that passes `--promote` rebases, because
promotion's rebase drops a merge commit. Set uncommitted work aside in a WIP commit, never
the stash, which is shared across worktrees and sessions; the `Bash(git *stash)` deny rule
matches any command ending in `stash`. On a dirty tree, first `git add -A` and
`git commit -m "WIP set-aside"`, then:

- rebase: `git rebase origin/<mainline>`, then, since rebase drops a WIP already upstream,
  `test "$(git log -1 --format=%s)" = "WIP set-aside" && git reset --soft HEAD~1`
- merge: `git switch --detach HEAD~1`,
  `git merge -m "Merge <mainline> into <branch>" origin/<mainline>`,
  `git cherry-pick --no-commit <branch>`, `git switch -C <branch>`; the branch holds the
  WIP commit, so the merge never contains it

On a conflict, resolve by step 2 of Conflict resolution, `git add` each resolved file, then
`git rebase --continue`, `git merge --continue`, or `git cherry-pick --quit`. No re-review,
since nothing has been reviewed yet.
`checked: false` with a `reason` means freshness is unknown; proceed. `--no-fetch` skips this check and omits `mainlineFreshness`; promotion re-verifies when origin exists and refuses failed fetches or a missing remote mainline with `MAINLINE_UNVERIFIED`.

An unresolved mainline warns; landing pushes the feature branch without promotion.

**No policy.** A missing `policy` field (the warning names the reason) means the machine
profile has not been applied. `main` and `master` are still guarded, so `branchAllowed`
still answers the branch question. Do not promote: run `land.ts` without `--promote` and
tell the carbon unit to run `~/.dotfiles/script/bootstrap --profile <name>` from the main checkout.

## Step 2: review

One review is the gate. What the writer changes after it is checked by re-running each
finding's proof and then the suite.

**Skip the review** for a mechanical follow-up with passing tests: a pure rename, or a
reviewer's suggestion applied verbatim. A review there costs minutes and finds nothing. Go
straight to **Step 3: write the message**. Any logic change, however small, gets the review.

**Step 0, once.** Run `ai-slop-cleaner` on preflight's `paths` as its file list, identifying `/commit` as the caller.

**Then one review, one writer, and the commit.** A second sweep of the same diff finds a
fresh batch of MEDIUM findings every time, so the review runs once and reports only what a
lane proved: every finding carries a `Proof:`, a command with its output or quoted lines,
and the writer re-runs that proof in place of a confirming review.

1. Invoke `/code-review` with target `working`, the repo path, preflight's `paths`
   as `--paths`, and one or two sentences of what changed and the goal
   it serves. Always `working`, never `staged`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Read its header lines — `VERDICT`, `ACTIONABLE`, `TRUNCATED` — and act:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; a failed review is never a passed one.
   - An `AMBIGUOUS` finding at MEDIUM or higher: stop and put it to the carbon unit with
     both readings stated. Fix it makes it `ACTIONABLE`, with the answer written into its
     body, and it joins the batch below; leave it makes it a `NIT`. Report lower severity
     `AMBIGUOUS` findings without interrupting.
   - `ACTIONABLE` at MEDIUM or higher: hand exactly those findings plus the changed-file
     list to the `finding-fixer` agent in a single spawn, and state that `Scope:` is that
     list, `Out of scope:` is pre-existing issues outside it, and `Definition of done:` is
     its finding-fixer receipt. LOW findings and `NIT`s are listed in the commit report and
     left alone.
   - No `ACTIONABLE` finding at MEDIUM or higher: go to **Step 3: write the message**.
3. Read the receipt, one line per finding, then run the test suite that covers the changed
   files, since the writer's edits postdate the review:
   - `FIXED`: the writer re-ran the finding's proof and the defect is gone. One line in the
     commit report.
   - `UNVERIFIED`: an edit whose proof the writer could not run. Run that proof yourself.
     Gone makes it `FIXED`; still unrunnable puts the finding in the message's `Not-tested`
     trailer, and `Confidence` stays below `high` while that trailer names one.
   - `DECLINED`: the writer reports no edit. Run the finding's proof yourself. A proof that
     shows no defect refutes the finding, which goes in the commit report; one that still
     shows it leaves a live defect, named in the commit report.
   - Snapshot the tree again the way `/code-review` pins a `working` target, then read
     `git diff <pin> <new tree>`, with `<pin>` the tree `/code-review`'s summary reported.
     That diff is everything the writer changed, and a hunk no `FIXED` or `UNVERIFIED` row
     accounts for goes in the `Not-tested` trailer, since a declined finding can leave a
     half-applied edit behind.
   - A receipt that never arrives, does not parse, or omits a finding counts every finding
     missing from it as `DECLINED`.
   - A failing suite is yours to fix at the root cause before the commit. Re-run every
     `FIXED` finding's proof after that edit, since it postdates them; the review is not
     run again for it.

A HIGH or CRITICAL finding left live or `UNVERIFIED` withholds promotion, never the commit:
run `land.ts` without `--promote`, so the feature branch is pushed and mainline is
untouched, and name each such finding in the commit message body, so the decision is
visible in history rather than only in the chat report. Where `policy.afterCommit` is
`promote`, say in the report that a later plain re-run with `--promote` carries the commit
onto mainline once a carbon unit has looked at those findings; under any other policy
**Step 4: land** already omits the flag and nothing is withheld.

A `TRUNCATED` line naming a lane goes in the commit report, since nothing sweeps for the
overflow that lane dropped, and so does a nonzero `Dropped unproven` count from the review
summary, since those rows were never triaged.

**A merge you resolve by hand invalidates the review of the branch it lands on.** A clean
merge is not a safe merge: integration can change a helper in one file while the reviewed
change adds its caller in another. Where the recovery sections say **re-review**, they mean
steps 1 to 3 of this review, run fresh on the merged tree.

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
Ticket: <spec-slug>/<ticket-id>
```

`type` is one of feat, fix, refactor, chore, docs, test, style, perf, build, ci.
`description` is one line, 72 characters or fewer, no trailing period. Trailers are
optional as a block, but a message that carries any trailer must carry `Confidence` and
must carry `Scope-risk`; `Constraint`, `Rejected`, `Directive`, and `Not-tested` are
included only when they apply, and `Ticket` only on the commit that lands one ticket of an intent, where a resumed build reads it to find the tickets left. Omit the whole trailer block only for a genuinely trivial change (a
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
  those files were unstaged and remain in the working tree.
- `--promote`: pass it when `policy.afterCommit` is `promote`. It carries the commit
  by rebasing the feature branch onto `policy.resolved.mainline`, fast-forwarding
  mainline, and pushing mainline. Omit it when the
  disclosure check held the change back, when the user asked for commit-only ("commit
  only", "don't merge"), when `policy.afterCommit` is `pull-request`, or when there is no
  policy.
- `--no-push`: only when the user asks for local-only work or the disclosure check held
  the change back.

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
  session's, land them by running this whole workflow in that worktree, review
  included. Never commit them by hand to clear the way. Changes you cannot attribute are a
  stop case.
- Transient network or remote errors: re-run once before treating the failure as real.

Stop and report only when the failure is authentication, permissions, or branch protection;
when the same failure survives two recovery passes; or when fixing would mean touching
changes you cannot attribute.

## After the commit

Read `policy.afterCommit`:

- `promote`: promotion already ran inside `land.ts`. Never merge branches
  yourself (sole exception: the recovery above), even when asked to "just merge it
  quickly"; re-run `land.ts` instead.
- `pull-request`: never merge the feature branch anywhere. When the disclosure check held
  the change back, stop after reporting; a public pull request discloses it too. Otherwise
  offer to open a pull request against the repository's mainline with `/open-pr`. If the
  carbon unit declines, stop after reporting. `/pr-review` reviews a pull request only when asked for by name.
