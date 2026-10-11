---
name: spec
description: Turns a feature request into a design spec. Sketches the feature from the repo, asks the carbon unit rounds of questions until every decision and edge case is settled, cuts the result into ticket-sized slices, and runs plan-challenge on them. Use for /spec, "spec this", "sharpen this", "grill me on this", and any feature request that used to go through plan mode.
---

# Spec

Surface a feature's hidden decisions while the carbon unit is here to make them.

Terms: design spec, sketch, branch, question round, decision, open question, slice, ticket, challenge stamp. Defined in `~/.dotfiles/GLOSSARY.md`; read it first.

**Input.** The feature in the carbon unit's words and the repo in the working directory.

**Output.** A design spec at `~/.claude/specs/<repo>/<slug>.md` ending in its challenge stamp. It is the only file this skill writes.

## Subskills

Read each file under `subskills/` as you reach it.

| Order | Subskill | Status it sets |
|-------|----------|----------------|
| 1 | `sketch.md` | `sketch` |
| 2 | `grill.md` | `grilled` |
| 3 | `slice.md` | `sliced` |
| 4 | `challenge.md` | `challenged` |

An existing design spec resumes at the subskill after its Status.

## Design spec file

```text
# <feature name>

Status: <sketch | grilled | sliced | challenged>
Request: <the carbon unit's words, verbatim>

## Goal
<one or two sentences>

## Non-goals
- <the nearest thing this feature leaves out>

## Branches
- B1: <question> | leaning: <current guess> | blocks: <B numbers>

## Decisions
- D1: <question> | answer: <choice> | why: <reason> | source: <decided | read file:line | assumed>

## Open questions
- Q1: <question> | settled by: <what would answer it> | defers: <slices waiting on it>

## Slices
1. <verb phrase naming the change>
   - implements: <D numbers>
   - reads: <paths>
   - changes: <paths>
   - done when: <command to run or behavior to observe>
   - depends on: <slice numbers>

CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut
```

Inside Slices, slice heads are the only numbered lines at column zero and their fields stay indented, because `plan-challenge` reads every column-zero numbered line as a step.

## Hand off

Reply with the path, the slice count, every open question with the slices it defers, and every `assumed` decision. Implementation and ticket cutting begin when the carbon unit starts them.
