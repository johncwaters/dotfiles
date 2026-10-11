# Grill

Close every branch.

1. Close each branch the repo answers as a `read` decision. Ask the carbon unit the rest.
2. Order by what deletes the most questions: scope, then behavior, then failure and edge cases, then naming. A blocking branch goes before the branches it blocks.
3. Ask a question round with AskUserQuestion: up to four mutually independent questions, each offering two to four real alternatives with their costs, the recommended one first, marked `(Recommended)`, with its reason.
4. Write every answer into the design spec right away. A chosen option or a settling free-text answer becomes a `decided` decision. A partial answer records what it settled and returns as a narrower question. A redirecting answer rewrites Goal, Non-goals, and the affected branches first.
5. Add the branches each answer opened, plus every fork these probes reveal:
   - Scope: the nearest thing left out.
   - Input: empty, huge, malformed, duplicate.
   - Failure: a dependency failing, a halfway stop, a rerun.
   - Existing state: data, config, and machines that predate the feature.
   - Reach: other callers, profiles, and platforms.
   - Removal: how the feature is retired.
   - Proof: the observable result that shows it works.
6. Repeat until Branches is empty. A branch whose options all lead to the same slices closes on its recommendation as `assumed`. When the carbon unit ends early, each remaining branch closes the same way, or becomes an open question where the recommendation is weak.
