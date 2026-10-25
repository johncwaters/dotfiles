# Fix

Fix the `ACTIONABLE` findings at MEDIUM or higher yourself, in this session. Nothing reviews these edits afterwards, so each finding's own proof is the check.

Each finding's `body` names the defect, the `Proof:` that shows it, and usually the fix. Take the fix as a strong suggestion: a better one is fine when its blast radius is equal or smaller and every edit stays inside the changed-file list; say so in the commit report.

1. Run the finding's `Proof:` before editing: the command, or a re-read of the quoted lines.
2. Make the smallest edit at the source that removes the defect. Suppression comments, disabled rules, widened types, swallowed errors, and skipped tests leave it in place; a real upstream blocker gets a one-line comment naming the issue and the removal trigger.
3. Run the same proof again and give the finding one outcome:
   - `FIXED`: the proof no longer shows the defect.
   - `UNVERIFIED`: you edited but the proof cannot run here.
   - `DECLINED`: no edit, because the proof shows no defect, the fix needs a design decision the finding leaves open (ask the carbon unit), it needs a file outside the changed-file list, or two findings prescribe contradictory fixes to the same lines. A declined finding leaves no edit behind.
4. Name a defect you notice on the way in the commit report and leave it alone.

Fix only the findings handed over; `NIT` and `AMBIGUOUS` ones stay as review.md routes them.
