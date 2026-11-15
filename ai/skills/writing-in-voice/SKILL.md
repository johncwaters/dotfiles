---
name: writing-in-voice
description: "Writes as the carbon unit, in their voice, anything someone else reads. Message path: Slack, email, texts, replies. Published path: GitHub issues and PRs, their comments and review replies, docs, tutorials, RFCs, design docs, blog, launch and social posts, pitches, demo scripts, changelogs, post-mortems. Use when asked to write, reply, rewrite, tighten, or critique one, for \"say this in my voice\", \"make this punchier\", or \"tell the story\", and before any draft posted as them, even mid-code-task."
---

# Writing in voice

Everything written on the carbon unit's behalf for someone else to read goes through this skill: one voice, one list of tells, one lint, and a path picked by who reads it. Chat replies to the carbon unit are not drafts.

## Core principle

The carbon unit writes like a senior engineer in casual-professional mode: warm but efficient, technically precise while staying relaxed. Think "the teammate everyone likes getting messages from." Both paths respect a smart, busy reader; the message path keeps the human quirks, and the published path trades them for structure.

## Pick the path

- **Message**: a turn in a conversation, read now by the carbon units in it (Slack, email, texts, chats, a customer reply). Follow [subskills/message.md](subskills/message.md).
- **Published**: posted where others read it later (a GitHub issue, PR description, issue or PR comment, review reply, docs page, tutorial, RFC, design doc, blog or social post, changelog, post-mortem). Follow [subskills/published.md](subskills/published.md), which picks its template: `subskills/blog-or-post.md`, `subskills/docs-or-tutorial.md`, or `subskills/launch-or-pitch.md`.
- A calling skill that names a path wins over this list, even when its text lands on GitHub or a ticket.
- A profile may name a skill that adds its own conventions on top of either path; load it before drafting.

## Shared rules

- **A supplied draft's facts are fixed.** Rewriting a draft the carbon unit wrote? Their facts, nouns, and claims stay. Reorder and cut, but add no detail they did not write, and ask when a sentence needs one.
- **Lead with the new part.** Sharing something (a demo, a doc, a PR)? Settle first whether the audience already saw it. If they did, skip the intro and recap of what it is.
- **Name the code, not the person.** Writing up a bug's cause, name the code and why it exists rather than who added it ("came in with #19560", "added by @x"): naming them reads as blame and pings them.

## Tells that mark prose as machine-written

Readers can tell, and these are not how the carbon unit writes. Strip every one on sight, on both paths. `scripts/lint-draft.mjs` flags filler words, machine vocabulary, corporate openers and sign-offs, em dashes, kicker clauses, teasers, a message over 50 words or with 2 or more code spans, and, with `--longform`, emoji bullets; these it does not:

- **Reflexive triplets**, "It's not X, it's Y" more than once per piece, stacked rhetorical questions, uniform sentence length, and emoji bullets in a message.
- **Endings that recap**, or a name signed under the message.
- **An aphorism standing in for the fact** ("A switch you've flipped zero times is a switch you hope works"). State the fact or the instruction.
- **A balanced contrast pair the reader must decode** ("A flag decides whether someone gets a feature, and a payload decides how"). Say what the thing is.
- **A dramatized cost** ("A rollback is a revert, a build, and a deploy, and your users see the bug for as long as all three take"). Name the concrete steps plainly.
- **A setup line narrating the story's progress** ("It's a pretty average conversation, nothing out of the norm"). Start at the event.

Docs reviewers call the last four "Claudish" and send the page back.

## Scripts

- `scripts/lint-draft.mjs`: run `node ~/.claude/skills/writing-in-voice/scripts/lint-draft.mjs <draft-file>` (or pipe the draft on stdin) on every draft before showing or sending it, adding `--longform` on the published path, and rewrite or delete each flagged sentence as its output says until it exits 0.
