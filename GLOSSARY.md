# Glossary

One meaning per word, so a skill, a ticket, and a carbon unit asking for "a spec" all mean
the same thing. A doc that leans on these terms opens with a `Terms:` line citing this file
as `~/.dotfiles/GLOSSARY.md`; `test/repo-wiring.sh` fails when a cited term is not defined
here.

- **design spec**: The single document that states what a feature is, what it is not, and
  every decision behind it, complete enough that an agent holding none of the originating
  conversation could build it. It is a typed JSON graph of nodes and edges that the `spec`
  skill writes to `~/.claude/specs/<repo>/<slug>.json`; `ai/skills/spec/lib/graph.ts` is
  the type, and a write hook refuses a graph that breaks it. Once its tickets are built,
  it moves to `~/.claude/spec-archive/<repo>/` to review spec effectiveness over time,
  outside `~/.claude/specs` so no agent resumes or trusts a design that drifts from the
  code; `guard-workflow` clears the `/spec` gate on reads inside `~/.claude/specs`.
  It replaces the Claude Code plan as what `plan-challenge` judges.
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
  when the recommendation stood in for an answer the carbon unit never gave, or when the
  challenge overturned the answer they gave on evidence verified in the repo. Only the
  challenge may overturn a `decided` one; it then reads `assumed` and keeps the displaced
  answer in its reason, so the hand off lists both.
- **design node**: A settled piece of a feature's design written as code rather than prose,
  in one of three layers: behavior (a walkthrough or ASCII mockup), architecture
  (components, contracts, data model), or program (types, signatures, call graph,
  pseudocode). The carbon unit approves it before slicing, because review is cheapest
  before code exists; every design spec at medium risk or above carries one, and each
  ticket carries the design nodes its unit builds.
- **open question**: A branch deliberately left open, recorded with what would settle it.
  A unit of work that waits on one is deferred: it stays in the graph and out of the
  challenge, and the cut into tickets waits until the question is answered, because one
  design spec becomes one intent.
- **unit of work**: One node of work in a design spec, sized to become exactly one ticket
  and verifiable by itself. Its edges say which decisions it implements, which units it
  depends on, and which open question defers it.
- **contract**: What a unit of work binds its ticket to: the paths it may change, the
  commands that must exit 0 for it to count as done, and a reading budget that keeps it
  inside one session. The validator enforces that every unit has one, and the ticket
  carries it.
- **ticket**: One unit of work cut into a self-contained work order that an agent finishes
  in a single session of roughly 150k tokens of context, counting everything that session
  reads, writes, runs, and reviews. Self-contained because a resumed or compacted
  session starts from the intent file, and the design spec is archived once built, so
  the ticket carries its contract and the decisions it implements.
- **intent**: The parent work order for a whole feature: its objective, success criteria,
  risk tier, boundary, and write scopes, with every ticket that builds it.
  `ai/skills/spec/cut.ts` renders a challenged design spec as one intent file beside the
  spec with no model in the path, so the same spec always gives the same intent. The
  session that wrote the design spec builds the whole intent, so one builder owns the
  order its tickets land in.
- **challenge stamp**: The `CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut` line
  `plan-challenge` produces for what it judged, stored in a design spec's
  `challengeStamp` beside `challengedUnitIds`, the ids of the units it judged. It means
  those units survived adversarial simplification; the validator refuses a stamp once the
  units ready for work differ from that list, because a stamp says nothing about a unit no
  challenger saw. An unstamped design spec is not ready to be cut into tickets.
