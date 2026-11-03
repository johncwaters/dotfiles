# Slice

Cut the work into units, each sized for a ticket agent that starts with only the ticket.

1. Add units as vertical slices, each leaving the repo working with one more observable result, and a `dependsOn` edge to each unit it builds on. The first unit is the thinnest end-to-end path; later units widen it. A layer on its own, such as types or a schema, joins the first slice that uses it. Ask the slice order and boundaries through `ask.md` where they could go more than one way.
2. Write each unit's contract: `reads` is what the ticket agent studies first, `changes` is every path it may touch, and `checks` are the commands specific to the unit that exit 0 once it is done; leave out the repo's bare typecheck, lint and test commands, which `build.md` runs for every ticket, and leave `checks` empty when nothing narrower proves the unit.
3. Fit the reading budget. The validator sizes `reads` whole plus each `changes` path outside them at no more than 20000 bytes, since edits in a large file are found by search, and counts a `reads` path the unit also changes the same way when the unit creates a path no unit it depends on changes, since a split moves blocks found by search, at four bytes per token against 50k tokens, leaving the rest of a 150k session for the work. Split a unit above it; where the smallest verifiable unit is still above it, keep that unit whole with a `budgetWaiver` saying why.
4. Set each unit's `serves` to the numbers of the goal criteria it makes true, at least one; the ticket carries those criteria, so its agent checks them instead of leaving them to the intent's verifier. A criterion about what an agent can do is served by every unit on its path, including the one granting that agent the permission and the prompt line.
5. Join each unit to every decision it enacts and every design node it builds with an `implements` edge; the ticket carries those decisions and that code once the design spec is deleted. Mark a decision that binds every unit `isConstraint`.
6. Give a unit that waits on an open question a `deferredBy` edge to it, and the same edge to every unit that depends on that unit.
7. Set status `sliced`.
