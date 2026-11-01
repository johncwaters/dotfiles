# Review

One review is the gate. What you fix after it is checked by re-running each
finding's proof and then the suite.

**Skip the review** for a pure rename or a reviewer's suggestion applied verbatim, with
passing tests, or a working tree `/converging-reviews`'s `round.mjs verify` passes. Go straight to **Step 3: write the message**. Any logic change, however small, gets the review.

**Step 0, once.** Run `cleaning-ai-slop` on preflight's `paths` as its file list. Edit existing files only, including tests; run existing tests only. Limit naming, error-handling cleanup, and low-value test removal to lines already changed.

**Then one review, the fixes, and the commit.** A second sweep of the same diff finds
fresh MEDIUM findings every time, so the review runs once and reports only what a
lane proved: every finding carries a `Proof:`, a command with its output or quoted lines,
and you re-run that proof in place of a confirming review.

1. Invoke `/reviewing-code` with target `working`, the repo path, preflight's `paths`
   as `--paths`, and one or two sentences of what changed and the goal
   it serves. Use only `working`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Read its header lines — `VERDICT`, `ACTIONABLE`, `TRUNCATED` — and act:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; a failed review counts only as failed.
   - An `AMBIGUOUS` finding at HIGH or higher: stop and put it to the carbon unit with
     both readings stated. Fix it makes it `ACTIONABLE`, with the answer written into its
     body, and it joins the batch below; leave it makes it a `NIT`. Report lower severity
     `AMBIGUOUS` findings without interrupting.
   - `ACTIONABLE` at HIGH or higher: fix exactly those by [Fix](fix.md). MEDIUM findings
     and `NIT`s are listed in the commit report and left alone.
   - No `ACTIONABLE` finding at HIGH or higher: go to **Step 3: write the message**.
3. Report each fixed finding's outcome, then run the test suite that covers the changed
   files, since the fixes postdate the review:
   - `FIXED`: one line in the commit report.
   - `UNVERIFIED`: the finding goes in the message's `Not-tested` trailer, and
     `Confidence` stays below `high` while that trailer names one.
   - `DECLINED`: a proof that shows no defect refutes the finding; one that still shows
     it leaves a live defect. Either goes in the commit report.
   - A failing suite is yours to fix at the root cause before the commit. Re-run every
     `FIXED` finding's proof after that edit, since it postdates them; the review is not
     run again for it.
   - A failing test is pre-existing only when an `origin/<mainline>` worktree on the
     checkout's dependencies fails it with the same error. Proceed without blocking or
     asking the carbon unit: name it in the message's `Constraint` trailer and land.

**Stamp the tree last**, after every fix and the suite, skipped review included:
`node "$HOME/.claude/skills/landing/stamp.ts" write --gate gating-reviews --paths <preflight paths> --findings -`
with `{liveFindings, unverifiedFindings, preexistingFailures, truncatedLanes, droppedUnproven}`
on stdin, each finding `{severity, file, summary}`. A live or `UNVERIFIED` HIGH+ on any branch
stamp makes `land.ts --promote` return `PROMOTE_WITHHELD`; name each in the message body.

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

