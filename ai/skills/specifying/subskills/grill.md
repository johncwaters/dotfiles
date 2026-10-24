# Grill

Close every branch.

1. On a resume that brings the answer to an open question, first write status `sketch` with `challengeStamp` and `challengedUnitIds` removed. Then turn that node into a `decided` decision and remove its `deferredBy` edges.
2. Close each branch the repo answers as a `read` decision. Ask the carbon unit the rest.
3. Order by what deletes the most questions: scope, then behavior, then failure and edge cases, then naming. Follow the `blocks` edges.
4. Ask each round through `ask.md`. The round that closes the last branch also asks `risk` (low, medium, high, critical) and `criteria` (1 to 12 observable success criteria) for the goal; when `read` decisions or an early end close the last branch, ask them in one round before step 6 routes on risk. Word each criterion from the seat of whoever observes it: when an agent gains a capability, the criterion says that agent exercises it from its own lane, not only that the mechanism works when called directly.
5. Add the branches each answer opened, plus every fork these probes reveal:
   - Problem: who hits it today, and what they do instead.
   - Behavior: the desired flow step by step, with an ASCII mockup in a preview for a UI.
   - Scope: the nearest thing left out.
   - Input: empty, huge, malformed, duplicate.
   - Failure: a dependency failing, a halfway stop, a rerun.
   - Existing state: data, config, and machines that predate the feature.
   - Reach: other callers, profiles, and platforms.
   - Removal: how the feature is retired.
   - Proof: the observable result that shows it works.
6. Repeat until zero branches remain. At risk `low`, set status `grilled` and continue to `slice.md`; above `low`, keep status `sketch` and continue to `design.md`. A branch whose options all lead to the same units closes on its recommendation as `assumed`. When the carbon unit ends early, each remaining branch closes the same way, or becomes an open question where the recommendation is weak.
