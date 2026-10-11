# Glossary

One meaning per word, so a skill, a ticket, and a carbon unit asking for "a spec" all mean
the same thing. A doc that leans on these terms opens with a `Terms:` line citing this file
as `~/.dotfiles/GLOSSARY.md`; `test/repo-wiring.sh` fails when a cited term is not defined
here.

- **design spec**: The single document that states what a feature is, what it is not, and
  every decision behind it, complete enough that an agent holding none of the originating
  conversation could build it. The `spec` skill writes it to
  `~/.claude/specs/<repo>/<slug>.md`, outside any repo, because it is deleted once its
  tickets exist: a spec that outlives its tickets drifts from the code and gets trusted
  anyway. It replaces the Claude Code plan as what `plan-challenge` judges.
- **sketch**: The first draft of a design spec, written from the feature request and a read
  of the repo before any question is asked. It exists so questions attack something
  concrete; every guess in it is recorded as a branch, never as a decision.
- **branch**: A point where the design could go more than one way and the choice has not
  been made. Questioning ends when no branch is left: each one became a decision or an
  open question.
- **question round**: One batch of up to four questions put to the carbon unit at once,
  each with a recommended answer. Questions in a round never depend on each other's
  answers; a dependent question waits for the next round.
- **decision**: A closed branch, recorded with its answer, its reason, and its source:
  `decided` by the carbon unit, `read` from the repo at a cited file and line, or `assumed`
  when the recommendation stood in for an answer the carbon unit never gave. Nothing
  downstream may reopen a `decided` one without asking.
- **open question**: A branch deliberately left open, recorded with what would settle it.
  No slice may depend on one.
- **slice**: One numbered unit of work in a design spec, sized to become exactly one ticket
  and verifiable by itself.
- **ticket**: One slice cut into a self-contained work order that an agent finishes in a
  single session of roughly 150k tokens of context, counting everything that session
  reads, writes, runs, and reviews. Self-contained because the design spec is gone by the
  time the ticket is worked, so the ticket carries the decisions it implements.
- **challenge stamp**: The `CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut` line
  `plan-challenge` leaves as the last line of what it judged. On a design spec it means the
  slices survived adversarial simplification; an unstamped design spec is not ready to be
  cut into tickets.
