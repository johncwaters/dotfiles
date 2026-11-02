---
name: gating-reviews
description: Reviews local work once before it lands. Runs landing preflight, one /reviewing-code pass over the working tree, fixes only what that review proved broken, then stamps the reviewed tree so /landing commits exactly what was judged. Use for /gating-reviews, "review this before committing", or the review step before /landing.
---

# Gating Reviews

One review pass over local work, ending in a stamp that `land.ts` checks before it commits.

## Input

Uncommitted local work, and one or two sentences of what changed and the goal it serves.

Or the `commits` a `PROMOTE_WITHHELD` result names, oldest first: commits on the branch that never passed through `land.ts`.

## Commits

For `commits`, skip Preflight and the working-tree review. Invoke `/reviewing-code` with the base and head target `<oldest commit>^` and `HEAD`, and act on its findings as [Review](subskills/review.md) step 2 says: a fix lands through the steps below as new work. Once no `ACTIONABLE` finding at HIGH or higher stands, run `node "$HOME/.claude/skills/landing/stamp.ts" clear`, which records the branch's commits as landed, then rerun `land.ts --promote` with no message.

## Output

A stamp row over preflight's `paths`, carrying the findings left live or unverified, the pre-existing failures, and the truncated lanes. `/landing` writes its trailers from it.

## Steps

1. Run [Preflight](#preflight), so the stamp covers the integrated tree.
2. Follow [Review](subskills/review.md), which routes findings to [Fix](subskills/fix.md) and ends by writing the stamp.
3. Run `/landing`, carrying over any commit-only or local-only instruction.

## Preflight

Run `node "$HOME/.claude/skills/landing/preflight.ts" [--paths <file-or-dir> ...] [--no-fetch]`, with `--paths` when you know exactly which files this session
changed. Its `paths` is the scope of every step here.

**Branch guard.** `branchAllowed: false` means the profile or resolved mainline forbids
committing on this branch. `policy.commitBranches.onForbidden` permits only
`create-feature-branch`: create
a branch named for the work item, switch to it, and proceed.

**Mainline freshness.** A `mainlineFreshness.behind` above zero means integrate
`origin/<mainline>` with the verb the warning names, then re-run preflight.
Merge only for `afterCommit: pull-request` with an upstream, since rebasing a pushed
branch needs a force-push; a landing that passes `--promote` rebases, because
promotion's rebase drops a merge commit. Set uncommitted work aside only in a WIP commit;
the stash is shared across worktrees and sessions; the `Bash(git *stash)` deny rule
matches any command ending in `stash`. On a dirty tree, first `git add -A` and
`git commit -m "WIP set-aside"`, then:

- rebase: `git rebase origin/<mainline>`, then, since rebase drops a WIP already upstream,
  `test "$(git log -1 --format=%s)" = "WIP set-aside" && git reset --soft HEAD~1`
- merge: `git switch --detach HEAD~1`,
  `git merge -m "Merge <mainline> into <branch>" origin/<mainline>`,
  `git cherry-pick --no-commit <branch>`, `git switch -C <branch>`; the branch holds the
  WIP commit, so the merge excludes it

On a conflict, resolve by step 2 of [Conflict resolution](../landing/subskills/recovery.md#conflict-resolution), `git add` each resolved file, then
`git rebase --continue`, `git merge --continue`, or `git cherry-pick --quit`. No re-review,
since nothing has been reviewed yet.
`checked: false` with a `reason` means freshness is unknown; proceed. `--no-fetch` skips this check and omits `mainlineFreshness`; promotion re-verifies when origin exists and refuses failed fetches or a missing remote mainline with `MAINLINE_UNVERIFIED`.

An unresolved mainline warns; landing pushes the feature branch without promotion, unless the warning names a mainline `--promote` founds, which happens only while the current branch is the repo's only branch locally and on origin.

**No policy.** A missing `policy` field (the warning names the reason) means the machine
profile has not been applied. `main` and `master` are still guarded, so `branchAllowed`
still answers the branch question.
