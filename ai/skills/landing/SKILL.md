---
name: landing
description: Lands reviewed work through the personal commit workflow. Runs two deterministic steps (preflight, land) that stage exactly the tree a review gate stamped, commit, and push with typed outcomes, then promotes the feature branch onto the resolved mainline or leaves it pushed for /opening-prs, per the machine's commit policy. Use for /landing, "commit this", "commit and push", or landing finished work.
---

# Commit

Two deterministic steps own everything that touches git. A review gate
(`/gating-reviews` by default) stamps the tree first; you own the message and recovery. Stage, commit, push, or merge by hand only
within [recovery](subskills/recovery.md).

```
node "$HOME/.claude/skills/landing/preflight.ts" [--paths <file-or-dir> ...] [--no-fetch]
node "$HOME/.claude/skills/landing/land.ts" [--promote] [--no-push] <<'MSG'
<commit message>
MSG
```

Both print one JSON object on stdout and set the exit code from the outcome table.

## Step 1: preflight

Run `preflight.ts` first, with `--paths` when you know exactly which files this session
changed.
`land.ts` stages exactly the review stamp's paths.

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

On a conflict, resolve by step 2 of [Conflict resolution](subskills/recovery.md#conflict-resolution), `git add` each resolved file, then
`git rebase --continue`, `git merge --continue`, or `git cherry-pick --quit`. No re-review,
since nothing has been reviewed yet.
`checked: false` with a `reason` means freshness is unknown; proceed. `--no-fetch` skips this check and omits `mainlineFreshness`; promotion re-verifies when origin exists and refuses failed fetches or a missing remote mainline with `MAINLINE_UNVERIFIED`.

An unresolved mainline warns; landing pushes the feature branch without promotion.

**No policy.** A missing `policy` field (the warning names the reason) means the machine
profile has not been applied. `main` and `master` are still guarded, so `branchAllowed`
still answers the branch question. Run `land.ts` without `--promote` and
tell the carbon unit to run `~/.dotfiles/script/bootstrap --profile <name>` from the main checkout.

## Step 2: write the message

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
included only when they apply (`stamp.ts verify` prints the stamp: its `unverifiedFindings`
go in `Not-tested`, which keeps `Confidence` below `high`, its `preexistingFailures` in
`Constraint`, and each live HIGH+ in the body), and `Ticket` only on the commit that lands one ticket of an intent, where a resumed build reads it to find the tickets left. Omit the whole trailer block only for a genuinely trivial change (a
version bump with no logic change).

## Step 3: disclosure check

Many work repos are public, and a push publishes the diff and message to everyone. Before
landing, decide whether everything the landing would publish should reach the remote at
all: the working changes plus every local commit not yet on the remote, read with
`git log -p @{upstream}..HEAD`, or `git log -p origin/<mainline>..HEAD` when the branch has
no upstream. An earlier held-back commit among them holds back this landing too. Treat
`remoteVisibility.visibility` of `public` or `unknown` as public; `private` and `internal`
are not.

Keep these off a public remote:

- A fix for an exploitable vulnerability that has not been disclosed, its regression test,
  or a message describing the attack. The diff alone shows attackers what was open.
- Credentials, customer names or data, PII, internal hostnames, or incident details.

When the change carries any of them, run `land.ts` with `--no-push` and without
`--promote`, so the commit stays local, then stop and tell the carbon unit what you found.
A vulnerability fix goes through the repo's private channel instead: a GitHub security
advisory's temporary private fork, or whatever the repo's `SECURITY.md` names. Strip a
secret or customer detail out of the tree instead, then rerun the gate; one that already
reached a remote needs rotating, not just deleting.

Everything else lands normally. On a public remote, still write the message as public
text: name the defect class; keep exploit steps and customer identities out.

## Step 4: land

Pipe the message into `land.ts` with a quoted heredoc, so nothing in the message is
expanded by the shell:

```
node "$HOME/.claude/skills/landing/land.ts" --promote <<'MSG'
feat(thing): do the thing

Why it was done this way.

Confidence: high
Scope-risk: narrow
MSG
```

Flags:

- No path flag: `land.ts` stages exactly the last stamp's `paths`, and refuses with
  `NOT_REVIEWED` when no stamp matches the tree over them. Report `excluded staged files`
  warnings; those files stay in the working tree. New `.coherence/**/*.jsonl` files ride along.
- `--promote`: pass it when `policy.afterCommit` is `promote`. It carries the commit
  by rebasing the feature branch onto `policy.resolved.mainline`, fast-forwarding
  mainline, and pushing mainline. Omit it when the
  disclosure check held the change back, when the carbon unit asked for commit-only
  (`commit only`, `don't merge`), when `policy.afterCommit` is `pull-request`, or when there is no
  policy.
- `--no-push`: only when the carbon unit asks for local-only work or the disclosure check held
  the change back.

## Scripts

- `preflight.ts`: run first to resolve policy, freshness, branch eligibility, and scoped paths.
- `land.ts`: run after the message and disclosure checks to stage, commit, push, and optionally promote.
- `stamp.ts`: review gates write the stamp; `verify` prints it.

## Outcomes

Exit code carries the outcome; the JSON carries the detail and a typed `next`. Act on it:
`proceed` continues to the next step; `done` reports; `runGate` runs `gate`, then lands again; `rerun` reruns `script` with the same flags once `after` is done;
`fixAndRerun` fixes each of `items`, then reruns; `resolveConflicts` follows
[Conflict resolution](subskills/recovery.md#conflict-resolution); `askCarbonUnit` asks
`question`; `stop` relays `report`. Report one line with the outcome, short hash, and
message subject, then one line per finding fixed.

| Outcome | Exit |
|---|---|
| `COMMITTED` | 0 |
| `NOTHING_TO_COMMIT` | 13 |
| `MESSAGE_INVALID` | 20 |
| `HOOK_FAILED` | 21 |
| `DENYLISTED_FILE_STAGED` | 25 |
| `PUSH_FAILED` | 22 |
| `PROMOTE_CONFLICT` | 23 |
| `PROMOTE_FAILED` | 24 |
| `MAINLINE_AHEAD` | 26 |
| `POLICY_INVALID` | 27 |
| `BRANCH_FORBIDDEN` | 28 |
| `MAINLINE_UNVERIFIED` | 29 |
| `HOME_PATH_STAGED` | 30 |
| `NOT_REVIEWED` | 31 |
| `PROMOTE_WITHHELD` | 32 |
| `NOT_A_REPO` | 10 |
| `DETACHED_HEAD` | 11 |
| `OPERATION_IN_PROGRESS` | 12 |

`pushed: false` after successful mainline promotion is normal. Report safety-push failures
from `warnings`; the outcome stays unchanged.

## After the commit

Read `policy.afterCommit`:

- `promote`: promotion already ran inside `land.ts`. Merge branches yourself only in
  [recovery](subskills/recovery.md); even when asked to "just merge it quickly",
  re-run `land.ts`.
- `pull-request`: keep the feature branch unmerged everywhere. When the disclosure check held
  the change back, stop after reporting; a public pull request discloses it too. Otherwise
  offer to open a pull request against the repository's mainline with `/opening-prs`. If the
  carbon unit declines, or the remote is one `/opening-prs` cannot serve, report the pushed branch and stop; leave merging to the PR host. `/reviewing-prs` reviews a pull request only when asked for by name.
