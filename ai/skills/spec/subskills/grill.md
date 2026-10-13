# Grill

Close every branch.

1. On a resume that brings the answer to an open question, first write status `sketch` with `challengeStamp` and `challengedUnitIds` removed. Then turn that node into a `decided` decision and remove its `deferredBy` edges.
2. Close each branch the repo answers as a `read` decision. Ask the carbon unit the rest.
3. Order by what deletes the most questions: scope, then behavior, then failure and edge cases, then naming. Follow the `blocks` edges.
4. Ask a question round with AskUserQuestion: up to four mutually independent questions, each offering two to four real alternatives with their costs, the recommended one first, marked `(Recommended)`, with its reason.
5. Write every answer into the graph right away. A chosen option or a settling free-text answer turns the branch into a `decided` decision. A partial answer records what it settled and returns as a narrower branch. A redirecting answer rewrites the goal, the non-goals, and the affected branches first.
6. Add the branches each answer opened, plus every fork these probes reveal:
   - Scope: the nearest thing left out.
   - Input: empty, huge, malformed, duplicate.
   - Failure: a dependency failing, a halfway stop, a rerun.
   - Existing state: data, config, and machines that predate the feature.
   - Reach: other callers, profiles, and platforms.
   - Removal: how the feature is retired.
   - Proof: the observable result that shows it works.
7. Settle `risk` (low, medium, high, critical) and `criteria` (1 to 12 observable success criteria) with the carbon unit and write them on the goal. Word each criterion from the seat of whoever observes it: when an agent gains a capability, the criterion says that agent exercises it from its own lane, not only that the mechanism works when called directly.
8. Repeat until zero branches remain, then set status `grilled`. A branch whose options all lead to the same units closes on its recommendation as `assumed`. When the carbon unit ends early, each remaining branch closes the same way, or becomes an open question where the recommendation is weak.
