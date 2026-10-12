# Build

One session builds every ticket in an intent file, in the listed order.

1. Read `<slug>.intent.json`. Its objective, criteria and boundary bind every ticket.
2. List the tickets landed since the intent file was written with `git log --since=<when the intent file was written> --format='%(trailers:key=Ticket,valueonly)'`; each prints as `<slug>/<id>`, and an older one belongs to an earlier design spec of the same name. Resume at the first ticket still missing.
3. Work one ticket: study its `Read first` paths, change only its `writeScopes`, and finish when every criterion holds, each command it names exits 0, and the repo's own typecheck, lint and tests pass.
4. Land it through `/commit` as one commit carrying the trailer `Ticket: <slug>/<id>`, then start the next ticket.
5. After the last ticket lands, confirm each criterion of the intent against the landed commits, then delete the design spec and the intent file.
