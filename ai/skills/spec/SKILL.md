---
name: spec
description: Turns a feature request into a design spec, a typed and validated JSON graph of decisions and units of work. Sketches the feature from the repo, asks the carbon unit rounds of questions until every decision and edge case is settled, cuts the result into ticket-sized units with verifiable contracts, and runs plan-challenge on them. Use for /spec, "spec this", "sharpen this", "grill me on this", and before the first edit of any change that involves a choice: a feature, a behavior change, a refactor, a new skill, hook, agent, or config, a non-trivial bug fix, or a multi-file change, whether or not plan mode would have turned on. Skip only for a typo or mechanical edit, an edit the carbon unit dictated verbatim, or when the carbon unit says to skip it.
---

# Spec

Surface a feature's hidden decisions while the carbon unit is here to make them.

Terms: design spec, sketch, branch, question round, decision, open question, unit of work, contract, ticket, intent, challenge stamp. Defined in `~/.dotfiles/GLOSSARY.md`; read it first.

**Input.** The feature in the carbon unit's words and the repo in the working directory.

**Output.** A design spec at `~/.claude/specs/<repo>/<slug>.json` with status `challenged`, and once the carbon unit starts the cut, its intent file beside it.

## Subskills

Read each file under `subskills/` as you reach it.

| Order | Subskill | Status it sets | The graph then holds |
|-------|----------|----------------|----------------------|
| 1 | `sketch.md` | `sketch` | one goal, and a branch per guess |
| 2 | `grill.md` | `grilled` | zero branches |
| 3 | `slice.md` | `sliced` | units with full contracts, every decision implemented or a constraint |
| 4 | `challenge.md` | `challenged` | the challenge stamp |

An existing design spec resumes at the subskill after its status. A `challenged` one resumes in `grill.md` when the carbon unit brings the answer to an open question.

## Design spec graph

```json
{
  "status": "sliced",
  "request": "let me export my deck as csv",
  "repoRoot": "/home/me/Projects/decks",
  "nodes": [
    { "id": "G1", "kind": "goal", "text": "A deck exports to a CSV file from the deck page.", "risk": "low", "criteria": ["The exported CSV contains the deck names, sets, and quantities."] },
    { "id": "N1", "kind": "nonGoal", "text": "Importing a CSV." },
    { "id": "D1", "kind": "decision", "question": "Which columns?", "answer": "Name, set, quantity.", "why": "Matches what trading sites import.", "source": "decided" },
    { "id": "D2", "kind": "decision", "question": "Where is the CSV built?", "answer": "In the export module.", "why": "It already streams the JSON export.", "source": "read", "evidence": "src/export/index.ts:14" },
    { "id": "Q1", "kind": "openQuestion", "question": "Is price a column?", "settledBy": "The pricing provider's license terms." },
    { "id": "U1", "kind": "unit", "title": "Add the CSV writer", "reads": ["src/export/"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }], "serves": [1] },
    { "id": "U2", "kind": "unit", "title": "Add the price column", "reads": ["src/export/csv.ts"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }] }
  ],
  "edges": [
    { "from": "U1", "kind": "implements", "to": "D1" },
    { "from": "U1", "kind": "implements", "to": "D2" },
    { "from": "U2", "kind": "implements", "to": "D1" },
    { "from": "U2", "kind": "dependsOn", "to": "U1" },
    { "from": "U2", "kind": "deferredBy", "to": "Q1" }
  ]
}
```

Further fields: the goal carries `risk` (low, medium, high, critical) and `criteria` (1 to 12 observable results); a `branch` node is `{ "id": "B1", "kind": "branch", "question", "leaning" }` with `blocks` edges to the branches it precedes; a decision that binds every unit carries `"isConstraint": true`; a unit carries `"serves"`, the 1-based numbers of the goal criteria it makes true; a unit kept whole above the reading budget carries `"budgetWaiver": "<why>"`; a `challenged` spec carries `"challengeStamp"` and `"challengedUnitIds"`, the ids of the units the challenge judged.

The `validate-spec.mjs` write hook accepts a graph that passes `lib/graph.ts` for its status. Its denial names each rule and the fix; apply them and write again. Run the same checks, or view the graph, at any time:

```
node ~/.claude/skills/spec/validate.ts <spec.json>
node ~/.claude/skills/spec/render.ts <spec.json> tree
node ~/.claude/skills/spec/archive.ts <spec.json> built|abandoned
node ~/.claude/skills/spec/report.ts
```

Report lists archived specs with landed tickets and sweeps specs idle 14 days as abandoned; read an archive's structure with `render.ts tree`.

## Cut and build

A `challenged` design spec with every open question answered cuts into one intent, a ticket per unit:

```
node ~/.claude/skills/spec/cut.ts <spec.json>
```

It writes `<slug>.intent.json` beside the design spec, or names what to settle first. Build the whole intent in one dedicated session: read `subskills/build.md`.

## Hand off

Show the `tree` rendering, then reply with the path, every open question with the units it defers, every `assumed` decision, and every budget waiver. The cut and the build begin when the carbon unit starts them.
