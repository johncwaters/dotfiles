# Draft

## Shape

Every design doc opens with the same four beats, then adds the sections its kind needs:

1. **The answer.** One sentence: decision, recommendation, or status, with its number or date.
2. **Why now.** Intention and obstacle in two or three sentences.
3. **Reasoning.** Candid and specific, including the best counter-argument and the reply to it.
4. **The ask.** What feedback is needed, from whom, by when, as numbered questions a reader can answer in a comment.

The answer and the ask both sit above the fold: a reader who stops after the first screen knows what is proposed and what they are asked.

## Rules

- **Cut what does not move a decision.** Methodology narration, "how we got here" stories, and source lists go to the appendix or go away. When the author deletes a section, the doc did not need it.
- **One diagram per question.** A logical flow ("what happens to a PR") and an infrastructure map ("what runs where, across which trust boundary") answer different questions; a design section needs the second. Every box names where it runs, and every edge names what crosses it.
- **Scope in a table.** What the MVP covers, what comes later, and what is permanently out of scope, side by side, so a reader sees the edges without reading prose.
- **Mark the author's decisions as theirs.** Where a choice is still the author's to make, leave a visible TODO naming the choice for the author to fill in.
- **Borrow the story, keep the answer first.** Load `storytelling` for its work-doc row: frame the change on a real timeline, name the problem as the villain, give each number a comparison, and show it working.
- **Write in the author's voice.** Read the parts they wrote and match their sentence length, vocabulary, and how they hedge. Their edits to your drafts are the clearest signal: what they cut is fluff to them. When the carbon unit is the author, sentences follow `writing-in-voice`, unless an installed extension names its own sentence skill.
- **Lint every section before it goes in the doc.** Run `node ~/.claude/skills/writing-in-voice/scripts/lint-draft.mjs --longform <draft-file>`, delete or rewrite each flagged sentence as its output says, and rerun until it exits 0.
