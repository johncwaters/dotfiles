# Slice

Size each slice for a ticket agent that starts with only the ticket.

1. Order slices by dependency; each leaves the repo working.
2. Budget one slice at roughly 150k tokens of session context. Measure its reading with `wc -c` over the `reads` and `changes` paths at four bytes per token, and split a slice above about 50k tokens of reading.
3. Merge a slice into its neighbor until `done when` is a command to run or a behavior to observe, then measure the merged slice again.
4. List in `implements` every decision the slice enacts; the ticket carries them once the design spec is deleted.
5. Move a slice that depends on an open question, directly or through `depends on`, out of Slices into that question's `defers` field, then renumber.
