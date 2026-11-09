---
name: specifying
description: Turns a feature request into a design spec, a typed and validated JSON graph of decisions and units of work. Sketches it from the repo, asks the carbon unit rounds of questions until every decision is settled, cuts it into ticket-sized units with verifiable contracts, and runs challenging-plans on them. Use for /specifying, "spec this", "sharpen this", "grill me on this", and before the first edit of any change that involves a choice, as the spec_first rule defines it.
---

# Spec

Surface a feature's hidden decisions while the carbon unit is here to make them.

Terms: design spec, sketch, branch, question round, decision, design node, open question, unit of work, contract, ticket, intent, challenge stamp. Defined in `~/.dotfiles/GLOSSARY.md`; read it first.

**Input.** The feature in the carbon unit's words and the repo in the working directory.

**Output.** A design spec at `~/.agents/specs/<repo>/<slug>.json` with status `challenged`, its intent file beside it, and the intent built.

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from; the scripts and `subskills/` live there, whichever agent runs the skill.

## Subskills

Read each file under `subskills/` as you reach it.

| Order | Subskill | Status it sets | The graph then holds |
|-------|----------|----------------|----------------------|
| 1 | `sketch.md` | `sketch` | one goal, and a branch per guess |
| 2 | `grill.md` | `grilled` at risk `low`, else none (stays `sketch`) | zero branches |
| 3 | `design.md` | `grilled` | design nodes with every branch closed |
| 4 | `slice.md` | `sliced` | vertical units with full contracts, every decision and design node implemented or a constraint |
| 5 | `challenge.md` | `challenged` | the challenge stamp |

Every question round runs through `subskills/ask.md`.

An existing design spec resumes at the subskill after its status. A `challenged` one resumes in `grill.md` when the carbon unit brings the answer to an open question.

## Design spec graph

```json
{
  "status": "sliced",
  "request": "let me export my deck as csv",
  "repoRoot": "/home/me/Projects/decks",
  "nodes": [
    { "id": "G1", "kind": "goal", "text": "A deck exports to a CSV file from the deck page.", "risk": "low", "criteria": ["The exported CSV contains the deck names, sets, and quantities.", "The exported CSV carries a price per row when pricing is licensed."] },
    { "id": "N1", "kind": "nonGoal", "text": "Importing a CSV." },
    { "id": "D1", "kind": "decision", "question": "Which columns?", "answer": "Name, set, quantity.", "why": "Matches what trading sites import.", "source": "decided" },
    { "id": "D2", "kind": "decision", "question": "Where is the CSV built?", "answer": "In the export module.", "why": "It already streams the JSON export.", "source": "read", "evidence": "src/export/index.ts:14" },
    { "id": "Q1", "kind": "openQuestion", "question": "Is price a column?", "settledBy": "The pricing provider's license terms." },
    { "id": "I1", "kind": "design", "layer": "program", "title": "CSV writer", "at": "src/export/csv.ts", "code": "type CsvRow = { name: string; set: string; quantity: number };\nexport function writeDeckCsv(deck: Deck, out: Writable): Promise<void>;" },
    { "id": "U1", "kind": "unit", "title": "Add the CSV writer", "reads": ["src/export/"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }], "serves": [1] },
    { "id": "U2", "kind": "unit", "title": "Add the price column", "reads": ["src/export/csv.ts"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }], "serves": [2] }
  ],
  "edges": [
    { "from": "U1", "kind": "implements", "to": "D1" },
    { "from": "U1", "kind": "implements", "to": "D2" },
    { "from": "U1", "kind": "implements", "to": "I1" },
    { "from": "U2", "kind": "implements", "to": "D1" },
    { "from": "U2", "kind": "dependsOn", "to": "U1" },
    { "from": "U2", "kind": "deferredBy", "to": "Q1" }
  ]
}
```

Further fields: the goal carries `risk` (low, medium, high, critical), `criteria` (1 to 12 observable results), and at `sketch` an `upstream` written as `sketch.md` step 4 says; a `branch` node is `{ "id": "B1", "kind": "branch", "question", "leaning", "upstream" }` with `blocks` edges to the branches it precedes, its `upstream` written as `sketch.md` step 4 says; a `read` decision's `evidence` cites a path:line, a commit sha, or a backticked command; a decision that binds every unit carries `"isConstraint": true`; a `design` node holds the settled `code` of one `layer` (behavior, architecture, or program), with `at` naming the path a program design lands in, or of layer `machine`, carrying `states`, `transitions` as `[from, event, to]`, and `at`, its one writer; above low risk a spec carries a machine or a decision with `"lifecycle": "none"`; and each unit `implements` the design nodes it builds; a unit carries `"serves"`, the 1-based numbers of the goal criteria it makes true, at least one each; a unit kept whole above the reading budget carries `"budgetWaiver": "<why>"`; a unit that splits one large file into new ones carries `"splits": "<path>"`, so the reading budget counts that file at the changed-only cap; a `challenged` spec carries `"challengeStamp"` and `"challengedUnitIds"`, the ids of the units the challenge judged.

The `validate-spec.mjs` write hook accepts a graph that passes `lib/graph.ts` for its status. Its denial names each rule and the fix; apply them and write again. Run the same checks, or view the graph, at any time with the scripts below.

## Cut and build

A `challenged` design spec with every open question answered cuts into one intent, a ticket per unit:

```
node <skill-dir>/cut.ts <spec.json>
```

It writes `<slug>.intent.json` beside the design spec, or names what to settle first. The session that wrote the design spec becomes the intent's one dedicated session and builds all of it: read `subskills/build.md`.

## Hand off

Show the `tree` rendering, then reply with the path, the goal's criteria, every open question with the units it defers, every `assumed` decision, and every budget waiver. With an open question left, stop there. Settle each `assumed` decision and each changed design node, keep or restore, with a question round through `ask.md`; a restore follows `challenge.md` step 5, and a changed answer resumes in `grill.md`. A confirmed or accepted answer sets that decision's source to `decided`, keeping its `why`; a round the carbon unit ends early stops the hand off like an open question. Once none is left, unless the carbon unit asked for the design spec alone, cut and build without asking.

## Scripts

- `validate.ts`: `node <skill-dir>/validate.ts <spec.json>` runs the same graph checks the write hook runs, at any status.
- `render.ts`: `node <skill-dir>/render.ts <spec.json> tree|design` draws the graph; `tree` also reads an archive's structure.
- `cut.ts`: `node <skill-dir>/cut.ts <spec.json>` cuts a `challenged` design spec into its intent file, or names what to settle first.
- `archive.ts`: `node <skill-dir>/archive.ts <spec.json> built|abandoned` archives a design spec and its intent file.
- `report.ts`: `node <skill-dir>/report.ts` lists archived specs with landed tickets and sweeps specs idle 14 days as abandoned.
