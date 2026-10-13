# Slice

Cut the work into units, each sized for a ticket agent that starts with only the ticket.

1. Add one unit per piece of work that leaves the repo working, with a `dependsOn` edge to each unit it builds on.
2. Write each unit's contract: `reads` is what the ticket agent studies first, `changes` is every path it may touch, and `checks` are the commands that exit 0 once the unit is done.
3. Fit the reading budget. The validator sizes `reads` plus `changes` at four bytes per token against 50k tokens, leaving the rest of a 150k session for the work. Split a unit above it; where the smallest verifiable unit is still above it, keep that unit whole with a `budgetWaiver` saying why.
4. Set each unit's `serves` to the numbers of the goal criteria it makes true; the ticket carries those criteria, so its agent checks them instead of leaving them to the intent's verifier. A criterion about what an agent can do is served by every unit on its path, including the one granting that agent the permission and the prompt line.
5. Join each unit to every decision it enacts with an `implements` edge; the ticket carries those decisions once the design spec is deleted. Mark a decision that binds every unit `isConstraint`.
6. Give a unit that waits on an open question a `deferredBy` edge to it, and the same edge to every unit that depends on that unit.
7. Set status `sliced`.
