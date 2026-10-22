---
name: design-docs
description: Plan, draft, review, and ship a document a team will read and comment on, such as a design doc, MVP spec, RFC, proposal, or project status doc. Covers gathering sources and the doc's history, an answer-first structure, backing every claim with code citations and measured numbers (cost at real volume, measured rates over guessed scenarios), independent reviewer agents before sharing, and editing a doc the author is also editing without undoing their cuts. Use for "write a design doc", "MVP spec", "write up the plan for the team", "restructure this doc", "review this doc for gaps", or "make this doc shareable". Sentence-level prose style is out of scope for this skill.
---

# Design docs

A design doc is a request for comments, not a request for approval. It earns its readers' time when its first sentence is the answer, every number in it was measured, and nothing in it is there to look thorough. This skill sets what goes in and how it is checked.

Read each file under `subskills/` as you reach it:

1. [sources](subskills/sources.md): the doc's history, the code, and the numbers before any prose.
2. [draft](subskills/draft.md): answer first, the section order, and the author's voice.
3. [evidence](subskills/evidence.md): citations, measured rates, and cost math.
4. [review](subskills/review.md): independent reviewers from a brief.
5. [ship](subskills/ship.md): drafting beside the live doc, the author's edits, and the swap.

Then the subskill for the kind being written, which adds to every step above:

- [mvp-spec](subskills/mvp-spec.md): a minimum viable product design doc that asks the team for feedback before rollout.

## Extensions

Each installed skill whose name starts with `design-docs-` extends this one with a machine's conventions. Load every one listed among your available skills before step 1, then apply each section it adds at the step that section names. Extensions win over this skill's defaults.
