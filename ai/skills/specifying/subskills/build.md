# Build

One session builds every ticket in an intent file, in the listed order, and lands the intent as a whole.

1. Read `<slug>.intent.json`. Its objective, criteria and boundary bind every ticket; its `reviewGate` names the gate every ticket passes, `gating-reviews` when absent.
2. List the tickets landed since the intent file was written with `git log --since=<when the intent file was written> --format='%(trailers:key=Ticket,valueonly)'`; each prints as `<slug>/<id>`, and an older one belongs to an earlier design spec of the same name. Resume at the first ticket still missing.
3. Work one ticket: study its `Read first` paths, change only its `writeScopes`, and finish when every criterion holds, each command it names exits 0, and the repo's own typecheck, lint and tests pass. A path the ticket's own change forces, a fix its review gate proved there included, joins its `writeScopes` without asking when the edit settles nothing the design spec left open: add it to the unit's `changes`, with the `budgetWaiver` of `slice.md` step 3 if the reading budget then fails, and name it in the ticket's commit body. A path joined during the gate joins its fix step's write scope, and preflight reruns with it in `--paths` before the stamp, so the commit carries it. Ask only when the path brings a new decision.
4. Before the last ticket's gate, confirm each criterion of the intent against the landed commits and the working tree. Invoke the `<reviewGate>` skill over the ticket's work with one commit carrying the trailer `Ticket: <slug>/<id>`, commit-only (no `--promote`, no `opening-prs` offer) for every ticket but the last; the last lands by [`policy.afterCommit`](#landing-by-policyaftercommit). `gating-reviews` lands the ticket through the `landing` skill under that instruction.
5. A `NOT_REVIEWED` result from landing returns to step 4. Then start the next ticket.
6. `PROMOTE_WITHHELD` on the last ticket is acted on by its `next`: fix and rerun for a blocking finding, the `gating-reviews` skill with its `commits` for commits not landed through `land.ts`. A resumed build whose tickets have all landed finishes the last ticket's landing by [`policy.afterCommit`](#landing-by-policyaftercommit).
7. Archive the design spec and the intent file with `node <skill-dir>/archive.ts <spec.json> built` once the intent is promoted or its PR is open.

## Landing by policy.afterCommit

- `promote`: pass `--promote`; on a resumed build with nothing left to commit, run `land.ts --promote` with no message.
- `pull-request`: offer one PR through the `opening-prs` skill; on a resumed build, open the PR through it when none is open. Then run `stamp.ts clear`.
- `unresolved`: ask the carbon unit which of those two to do.
- No policy: leave the branch pushed.
