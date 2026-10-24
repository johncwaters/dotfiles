# Review

One review is the gate. What the writer changes after it is checked by re-running each
finding's proof and then the suite.

**Skip the review** for a mechanical follow-up with passing tests: a pure rename, or a
reviewer's suggestion applied verbatim. A review there costs minutes and finds nothing. Go
straight to **Step 3: write the message**. Any logic change, however small, gets the review.

**Step 0, once.** Run `cleaning-ai-slop` on preflight's `paths` as its file list. Edit existing files only, including tests; run existing tests only. Limit naming, error-handling cleanup, and low-value test removal to lines already changed.

**Then one review, one writer, and the commit.** A second sweep of the same diff finds a
fresh batch of MEDIUM findings every time, so the review runs once and reports only what a
lane proved: every finding carries a `Proof:`, a command with its output or quoted lines,
and the writer re-runs that proof in place of a confirming review.

1. Invoke `/reviewing-code` with target `working`, the repo path, preflight's `paths`
   as `--paths`, and one or two sentences of what changed and the goal
   it serves. Use only `working`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Read its header lines — `VERDICT`, `ACTIONABLE`, `TRUNCATED` — and act:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; a failed review counts only as failed.
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
   - Snapshot the tree again the way `/reviewing-code` pins a `working` target, then read
     `git diff <pin> <new tree>`, with `<pin>` the tree `/reviewing-code`'s summary reported.
     That diff is everything the writer changed, and a hunk no `FIXED` or `UNVERIFIED` row
     accounts for goes in the `Not-tested` trailer, since a declined finding can leave a
     half-applied edit behind.
   - A missing, unparseable, or incomplete receipt counts every finding
     missing from it as `DECLINED`.
   - A failing suite is yours to fix at the root cause before the commit. Re-run every
     `FIXED` finding's proof after that edit, since it postdates them; the review is not
     run again for it.
   - A failing test is pre-existing only when an `origin/<mainline>` worktree on the
     checkout's dependencies fails it with the same error. Proceed without blocking or
     asking the carbon unit: name it in the message's `Constraint` trailer and land.

A HIGH or CRITICAL finding left live or `UNVERIFIED` withholds only promotion:
run `land.ts` without `--promote`, so the feature branch is pushed and mainline is
untouched, and name each such finding in the commit message body, so the decision is
visible in history rather than only in the chat report. Where `policy.afterCommit` is
`promote`, say in the report that a later plain re-run with `--promote` carries the commit
onto mainline once a carbon unit has looked at those findings; under any other policy
**Step 5: land** already omits the flag and nothing is withheld.

A `TRUNCATED` line naming a lane goes in the commit report, since nothing sweeps for the
overflow that lane dropped, and so does a nonzero `Dropped unproven` count from the review
summary, since those rows bypassed triage.

**A merge you resolve by hand invalidates the review of the branch it lands on.** A clean
merge is not a safe merge: integration can change a helper in one file while the reviewed
change adds its caller in another. Where [recovery](recovery.md) says **re-review**, it means
steps 1 to 3 of this review, run fresh on the merged tree.

One carve-out, and only one: merging `origin/<branch>` into the same local branch needs no
re-review, because whatever is on the remote was reviewed by whoever landed it. Every other
merge, a feature branch into an integration branch included, is a combination nothing has
looked at.

