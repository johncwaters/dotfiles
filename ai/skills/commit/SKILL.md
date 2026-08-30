---
name: commit
description: Personal commit workflow. Reviews and fixes in a loop via /code-review, then runs two deterministic steps (preflight, land) that stage, commit, push, and promote a feature branch onto the resolved mainline with typed outcomes. Use for /commit, "commit this", "commit and push", or landing finished work.
---

# Commit

Two deterministic steps own everything that touches git. You own the review loop, the
commit message, and the recovery procedures. Never stage, commit, push, or merge by hand
outside the recovery sections below.

```
node "$HOME/.claude/skills/commit/preflight.ts" [--paths <file-or-dir> ...]
node "$HOME/.claude/skills/commit/land.ts" [--paths ...] [--promote] [--no-push] <<'MSG'
<commit message>
MSG
```

Both print one JSON object on stdout and set the exit code from the outcome table. `node`
must be 22.18 or newer; it runs the TypeScript directly, with no build step. `$HOME`
resolves in both bash and PowerShell.

## Step 1: preflight

Run `preflight.ts` first, with `--paths` when you know exactly which files this session
changed. It scopes what this run stages and reports, which is what keeps another session's
unstaged work out of the commit; anything already in the index rides along regardless,
because git commits the whole index, and `land.ts` names those files in `warnings`. Pass
the same restriction to `/code-review` later.

It answers four things: the outcome (`READY` or a refusal), the current `branch` and
whether `branchAllowed` permits committing on it, the `changed` and `untracked` files that
will be staged, and the machine's `policy`.

**Branch guard.** `branchAllowed: false` means the profile or resolved mainline forbids
committing on this branch. `policy.commitBranches.onForbidden` permits only
`create-feature-branch`: create
a branch named for the work item, switch to it, and proceed. `land.ts` repeats this guard
and returns `BRANCH_FORBIDDEN` before staging or committing if invoked directly on a
forbidden branch or resolved mainline. `POLICY_INVALID` means the profile still names an
unsupported remedy;
both entry points stop and name the profile file in `errors`. An absent `commitBranches`
key uses the fallback `main` and `master` guard without invalidating the policy.

`policy.resolved.mainline` is the destination for promotion. With `mainline: "auto"`,
preflight checks the `origin/HEAD` target, then `main`, then `master`. A literal policy
value selects that branch. An unresolved mainline warns but does not refuse preflight;
landing then commits and pushes the feature branch without promotion. A repository
`.claude/release-profile.json`, or the retired `.claude/release-profile.yml` when JSON is
absent, whose `git.integration` differs from the resolved mainline also warns without
refusing. JSON is authoritative when both exist.

**No policy.** A missing `policy` field (the warning names the reason) means the machine
profile has not been applied. `main` and `master` are still guarded, so `branchAllowed`
still answers the branch question. Do not promote: run `land.ts` without `--promote` and
tell the user to run `setup/apply`.

## Step 2: review loop

Nothing rewrites the code between the last review and the commit, so the review is the
gate.

**Step 0, once.** Run the `ai-slop-cleaner` skill with the explicit changed-file list from preflight. In this invocation it may not create files, including tests, and the UI/design checklist is out of scope.

**Then loop.**

1. Invoke `/code-review` with target `working`, the repo path, the explicit changed-file
   list from preflight as `--paths`, and one or two sentences of what changed and why.
   Always `working`, never `staged`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Read its first two lines, `VERDICT` and `ACTIONABLE`, and act:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; never treat a failed review as a passed one.
   - Any `AMBIGUOUS` finding at MEDIUM or higher, at any verdict: stop and put it to the
     carbon unit with both readings stated. Carry the answer into the next `/code-review`
     call as a stated decision so the finding is re-dispositioned; an `AMBIGUOUS` finding
     that survives an answer means the answer never reached the next round. Report lower
     severity `AMBIGUOUS` findings without interrupting.
   - `ACTIONABLE` at MEDIUM or higher and rounds remaining: hand exactly those findings
     plus the changed-file list to the `finding-fixer` agent in a single spawn, and state
     that `Scope:` is that list, `Out of scope:` is pre-existing issues outside it, and
     `Definition of done:` is its finding-fixer receipt. Then go back to step 1. LOW findings are
     listed in the commit report and left alone.
   - Any `ACTIONABLE` finding at MEDIUM or higher on the last permitted round: stop
     without dispatching the writer. Fixing after the final review leaves an unverified
     edit.
   - No `ACTIONABLE` finding at MEDIUM or higher, with a verdict of `APPROVE` or `APPROVE WITH NITS`: leave the loop.
3. At most **three** rounds. Still not passing after the third: stop, report the surviving
   findings and the round count, and do not run `land.ts`.

The loop exits when no `ACTIONABLE` finding of MEDIUM or higher remains, not on the
verdict: a MEDIUM finding dispositioned `ACTIONABLE` is a verified defect with a bounded
fix and still maps to a passing verdict. LOW never triggers another round.

Carry two separate lists into the next `/code-review` call, never merged: the findings
settled as `NIT` or `AMBIGUOUS`, and the `finding-fixer` receipt. The first suppresses
re-reporting; the second becomes a regression check, because a `FIXED` receipt is a claim
and the next round is what verifies it. A round where `finding-fixer` declines every
finding it was handed is a stop, not a retry.

`/code-review` is the only review on this path. Do not spawn a reviewer agent yourself and
do not invoke `/qa-swarm` directly.

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
version bump with no logic change). Never an em dash, en dash, or emoji anywhere.

Check a draft before landing with `node "$HOME/.claude/skills/commit/preflight.ts"
--check-message` and the message on stdin. `land.ts` runs the same validation and refuses
with `MESSAGE_INVALID` rather than committing something malformed.

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

- `--paths <file-or-dir> ...`: the same restriction passed to preflight and `/code-review`.
  Omit it only when the user asked to commit everything or you cannot enumerate what
  changed. A `warnings` entry naming files "already staged outside --paths" means the index
  carried work this run never scoped; say so when you report. A denylisted file staged that
  way stops the run outright rather than riding along, as `DENYLISTED_FILE_STAGED`.
- `--promote`: pass it when `policy.afterCommit` is `promote`. It carries the commit
  by rebasing the feature branch onto `policy.resolved.mainline`, fast-forwarding
  mainline, and pushing mainline. When origin has the mainline but no local branch, it
  materializes a local tracking branch from `origin/<mainline>` first. Omit it when the
  user asked for commit-only ("commit only", "don't merge"), when `policy.afterCommit`
  is `pull-request`, or when there is no policy.
- `--no-push`: only when the user asks for local-only work. It suppresses every push,
  including feature, mainline, safety, and remote branch deletion pushes. Promotion may
  still update local mainline; `warnings` names a locally promoted mainline left unpushed.

## Outcomes

Exit code carries the outcome; the JSON carries the detail. Report in as few words as
possible: one line with outcome, short hash, and message subject, then one short line per
finding fixed. Expand only on failures.

| Outcome | Exit | What to do |
|---|---|---|
| `COMMITTED` | 0 | `pushed` says whether the feature branch was pushed, `promoted` lists the branches promotion carried the commit into, and `deletedRemoteBranches` lists any merged `glissa/` branch that was pruned. Report |
| `NOTHING_TO_COMMIT` | 13 | With `--promote`, promotion still ran: report what `promoted` says. Without it, stop and relay |
| `MESSAGE_INVALID` | 20 | `errors` names each violation. Fix the message and re-run `land.ts` |
| `HOOK_FAILED` | 21 | A commit hook rejected the commit; its stderr is in `warnings`. Fix the cause, then re-run |
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

With `--promote` the feature-branch push is deferred until promotion determines whether
mainline absorbed it. When origin exists and `--no-push` is absent, `PROMOTE_FAILED`,
`MAINLINE_UNVERIFIED`, `MAINLINE_AHEAD`, and `PROMOTE_CONFLICT` all attempt a feature-branch
safety push. `pushed` reports whether that safety push succeeded. A safety-push failure is
added to `warnings` without replacing the original outcome.

Successful promotion to mainline does not push the feature branch: it fast-forwards into
mainline, so pushing it too would only leave a dead remote branch. `pushed: false` on a
`COMMITTED` mainline promotion is therefore normal, not a failure. Two consequences: a
merged remote branch named `glissa/*` is deleted once pushed mainline carries it, listed in
`deletedRemoteBranches` (a refused deletion is a warning, never an outcome change). A
missing mainline also pushes the feature branch and reports the skip in `warnings`.

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

`PUSH_FAILED` and `PROMOTE_FAILED` are yours to resolve the same way. `warnings` names the
root cause. Fix it, then re-run `land.ts` (keeping `--promote` when it was passed); a
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
- `pull-request`: never merge the feature branch anywhere. Offer to open a pull request with
  `/org-pull-request`, which applies the org's PR standards. If the user declines, stop
  after reporting. The pull request targets the repository's mainline. Reviewing a work
  pull request belongs to `/org-pr-review`; `/pr-review` is only a supplemental audit trail,
  and only when asked for by name.
