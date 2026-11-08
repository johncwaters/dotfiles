# Probe

Every Take and Adapt rests on assumptions about the world outside the source: a CLI's output shape, a socket path, an API field, a contract in the target repo. Check them before proposing, so the carbon unit picks from facts.

1. For each item, list the assumptions its landing depends on, one line each, with the check that confirms it: a command, a file read, a docs page.
2. Run now every check that reads this repo, this host, or official docs and nothing more: reading code and contracts, `command -v <tool>`, `--help` output, a socket's existence, a docs fetch. Print names, shapes, lengths, and exit codes, keeping secret values out of the output.
3. Checks that need another machine, a login, or a secret go into one probe script in the scratchpad, following the execution rule in `~/.claude/AGENTS.md`, with its full path in the reply.
4. Write each item's results on its `Probes:` field: passed, failed with what was found, or waiting on the script. A failed probe reshapes or drops the item before the reply goes out.
