# Recovery

Read the section for the reported outcome; the outcome codes are pinned by `../test/skill-doc.test.ts`.

## Contents

- [NOTHING_TO_COMMIT](#nothing_to_commit)
- [MESSAGE_INVALID](#message_invalid)
- [HOOK_FAILED](#hook_failed)
- [DENYLISTED_FILE_STAGED](#denylisted_file_staged)
- [HOME_PATH_STAGED](#home_path_staged)
- [PUSH_FAILED](#push_failed)
- [PROMOTE_CONFLICT](#promote_conflict)
- [PROMOTE_FAILED](#promote_failed)
- [MAINLINE_AHEAD](#mainline_ahead)
- [POLICY_INVALID](#policy_invalid)
- [BRANCH_FORBIDDEN](#branch_forbidden)
- [MAINLINE_UNVERIFIED](#mainline_unverified)
- [NOT_A_REPO](#not_a_repo)
- [DETACHED_HEAD](#detached_head)
- [OPERATION_IN_PROGRESS](#operation_in_progress)
- [Conflict resolution](#conflict-resolution)
- [Push and promote recovery](#push-and-promote-recovery)

## NOTHING_TO_COMMIT

With `--promote`, promotion still ran: report what `promoted` says. Without it, stop and relay

## MESSAGE_INVALID

`errors` names each violation. Fix the message and re-run `land.ts`

## HOOK_FAILED

A commit hook rejected the commit, or git could not stage a scoped file or unstage an out-of-scope one; git's stderr is in `warnings` and nothing was committed. Fix the cause, then re-run

## DENYLISTED_FILE_STAGED

The index would add a file the denylist names (`.env*`, `*.log`, `node_modules/`, `dist/`, `__pycache__/`); `files` lists them and nothing was committed. Unstage each one (`git restore --staged <file>`) and re-run, or put it to the carbon unit when it genuinely belongs in the commit

## HOME_PATH_STAGED

A staged line or the commit message holds a local path (this machine's home directory, or `/home/<name>` or `/Users/<name>` for the current username or one in `local-usernames.txt`), which publishes the owner's username and layout; `matches` lists each `file:line`, or `commit message:line`, and nothing was committed. Lines a commit hook stages or writes into the message are scanned too: the commit is made, rescanned, and reset back off the branch, leaving its changes staged. Replace each with a path the code derives at runtime (an env var, a path relative to the file, `os.homedir()`) or reword the message, restage, and re-run. There is no override: a path that genuinely belongs goes to the carbon unit, who commits it by hand

## PUSH_FAILED

The commit exists, the push did not land. Follow [Push and promote recovery](#push-and-promote-recovery)

## PROMOTE_CONFLICT

The commit exists. A conflicted feature rebase was aborted and `conflicts` names the files, or an empty list means mainline diverged from origin. Follow [Conflict resolution](#conflict-resolution)

## PROMOTE_FAILED

The commit exists; promotion stopped for a non-conflict reason named in `warnings`, and `promoted` says which branches did update. Follow [Push and promote recovery](#push-and-promote-recovery)

## MAINLINE_AHEAD

Local mainline has commits absent from origin. `localOnlyCommits` lists their SHAs. Push or drop them by hand, then re-run; publication requires that explicit action

## POLICY_INVALID

The applied profile uses unsupported commit policy vocabulary. Update the profile file named in `errors`, then re-run preflight

## BRANCH_FORBIDDEN

`land.ts` was invoked on the guarded `branch` and wrote nothing. Create and switch to a feature branch, then re-run preflight

## MAINLINE_UNVERIFIED

Origin exists, but fetch failed or `origin/<mainline>` is missing, so promotion refused. `warnings` carries the verification detail. Restore remote verification, then re-run

## NOT_A_REPO

Stop and relay

## DETACHED_HEAD

Stop and relay

## OPERATION_IN_PROGRESS

A merge, rebase, or cherry-pick is in flight (`operation`). Stop and relay

## Conflict resolution

`PROMOTE_CONFLICT` with files in `conflicts` is yours to resolve; continue through recovery.

1. On the feature branch, fetch origin and rebase onto `policy.resolved.mainline`.
2. Resolve each conflicted file on its merits: read both sides, keep both intents where
   they are independent, and pick the semantically correct result where they collide. Choose
   resolutions on their merits rather than blanket `--ours`/`--theirs`; retain changes you cannot account for.
3. Stage the resolutions and continue the rebase.
4. Re-review the rewritten feature range before it reaches mainline.
5. Re-run `land.ts` with the same flags so it finishes the fast-forward and push.
   `NOTHING_TO_COMMIT` there is expected.

An empty `conflicts` list means local mainline diverged from origin. Stop and put the
listed branch relationship to the carbon unit; leave a diverged mainline intact, without
merging, resetting, rebasing, or force-pushing it.

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
  included. Commit them only through this workflow to clear the way. Changes you cannot attribute are a
  stop case.
- Transient network or remote errors: re-run once before treating the failure as real.
- Feature push denied on permissions (403, "Permission denied"): the branch is pushing
  somewhere other than its PR head. Read the head with
  `gh pr view --json headRepository,headRefName`; when a configured remote points at that
  repository and `headRefName` is not main, master, develop, or the resolved mainline,
  run `git push <remote> HEAD:<headRefName>`,
  `git branch --set-upstream-to=<remote>/<headRefName>`, and
  `git config branch.<branch>.pushRemote <remote>`, then re-run `land.ts`, which now
  pushes there. The landing gate admits this push while /landing runs.

Stop and report only when the failure is authentication or branch protection; when a
permissions failure persists because no configured remote holds the PR head, the PR head
is main, master, develop, or the resolved mainline, or the push there is denied too; when
the same failure survives two recovery passes; or when fixing would mean touching changes
you cannot attribute.

