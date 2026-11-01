# Build

One session builds every ticket in an intent file, in the listed order, and lands the intent as a whole.

1. Read `<slug>.intent.json`. Its objective, criteria and boundary bind every ticket; its `reviewGate` names the gate every ticket passes, `gating-reviews` when absent.
2. List the tickets landed since the intent file was written with `git log --since=<when the intent file was written> --format='%(trailers:key=Ticket,valueonly)'`; each prints as `<slug>/<id>`, and an older one belongs to an earlier design spec of the same name. Resume at the first ticket still missing.
3. Work one ticket: study its `Read first` paths, change only its `writeScopes`, and finish when every criterion holds, each command it names exits 0, and the repo's own typecheck, lint and tests pass.
4. Run `/<reviewGate>` over the ticket's work with a commit-only instruction: no `--promote`, no `/opening-prs` offer, one commit carrying the trailer `Ticket: <slug>/<id>`. `gating-reviews` lands the ticket through `/landing` under that instruction. `converging-reviews` ending `STALLED`, `CAPPED` or `FAILED` stamps nothing: stop the build on this ticket and report the round, the ledger path and every live finding, with no landing, PR or promote until the carbon unit acts.
5. After `converging-reviews` ends `CLEAN`, land the ticket through `/landing` under the same commit-only instruction. A `NOT_REVIEWED` result from either landing returns to step 4. Then start the next ticket.
6. After the last ticket lands, confirm each criterion of the intent against the landed commits, then land the intent once by preflight's `policy.afterCommit`: `promote` runs `land.ts --promote` with nothing to commit, and `PROMOTE_WITHHELD` stops the build with its report; `pull-request` opens one PR through `/opening-prs`, then runs `stamp.ts clear`. No policy leaves the branch pushed.
7. Archive the design spec and the intent file with `node ~/.claude/skills/specifying/archive.ts <spec.json> built` once the intent is promoted or its PR is open.
