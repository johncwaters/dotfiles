---
name: writing-in-voice
description: "Writes as the carbon unit, in their voice, anything someone else reads. Message path: Slack, email, texts, chats, replies. Published path: GitHub issues, PR descriptions, issue and PR comments, review replies, docs, tutorials, RFCs, design docs, blog, launch and social posts, changelogs, post-mortems. Use when asked to write, reply, rewrite, tighten, or critique one, for \"say this in my voice\" or \"make this punchier\", and before any draft posted as them, even mid-code-task."
---

# Writing in voice

Everything written on the carbon unit's behalf for someone else to read goes through this skill: one voice, one list of tells, one lint, and a path picked by who reads it. Chat replies to the carbon unit are not drafts.

## Core principle

The carbon unit writes like a senior engineer in casual-professional mode: warm but efficient, technically precise while staying relaxed. Think "the teammate everyone likes getting messages from." Both paths respect a smart, busy reader; the message path keeps the human quirks, and the published path trades them for structure.

## Pick the path

- **Message**: a turn in a conversation, read now by the carbon units in it (Slack, email, texts, chats, a customer reply). Follow [subskills/message.md](subskills/message.md).
- **Published**: posted where others read it later (a GitHub issue, PR description, issue or PR comment, review reply, docs page, tutorial, RFC, design doc, blog or social post, changelog, post-mortem). Follow [subskills/published.md](subskills/published.md), which picks its template: `subskills/blog-or-post.md` or `subskills/docs-or-tutorial.md`.
- A calling skill that names a path wins over this list, even when its text lands on GitHub or a ticket.
- A profile may name a skill that adds its own conventions on top of either path; load it before drafting.

## Shared rules

- **A supplied draft's facts are fixed.** Rewriting a draft the carbon unit wrote? Their facts, nouns, and claims stay. Reorder and cut, but add no detail they did not write, and ask when a sentence needs one.
- **Lead with the new part.** Sharing something (a demo, a doc, a PR)? Settle first whether the audience already saw it. If they did, skip the intro and recap of what it is.
- **Name the code, not the person.** Writing up a bug's cause, name the code and why it exists rather than who added it ("came in with #19560", "added by @x"): naming them reads as blame and pings them.

## Tells that mark prose as machine-written

Readers can tell, and these are not how the carbon unit writes. Strip every one on sight, on both paths:

- **Filler words:** "just", "basically", "finally", in every sense.
- **Machine vocabulary:** "delve", "tapestry", "landscape", "game-changer", "unlock", "navigate the complexities".
- **Corporate preamble and sign-offs:** "I hope this email finds you well", "Just a friendly reminder", "Best,", "Cheers,", "Regards,", or a name under the message.
- **Em dashes as structure.** Use a colon, a parenthetical, or two sentences.
- **Kicker clauses** tacked onto a plain claim ("you flip the flag off, and nobody waits on a revert"). End the sentence at the fact ("without needing a revert").
- **Teasers** that announce a reason without giving one ("Here's why.", "This shows why."). Open with the reason itself.
- **Reflexive triplets**, "It's not X, it's Y" more than once per piece, stacked rhetorical questions, and uniform sentence length.
- **Endings that recap**, or open with "In conclusion" or "Ultimately".
- **Emoji bullets.**
- **An aphorism standing in for the fact** ("A switch you've flipped zero times is a switch you hope works"). State the fact or the instruction.
- **A balanced contrast pair the reader must decode** ("A flag decides whether someone gets a feature, and a payload decides how"). Say what the thing is.
- **A dramatized cost** ("A rollback is a revert, a build, and a deploy, and your users see the bug for as long as all three take"). Name the concrete steps plainly.
- **A setup line narrating the story's progress** ("It's a pretty average conversation, nothing out of the norm"). Start at the event.

## Lint

Lint every draft before showing or sending it, as `scripts/lint-draft.mjs` below says. Exit 1 lists each flagged sentence and its rule (comma splices, teasers, filler words, em dashes, kicker clauses, machine tells, corporate openers and closers, and on `--longform` vague quantities, hedges, emoji bullets and British forms). Delete or rewrite those sentences and rerun until it exits 0. Delete a comma-spliced sentence outright rather than repairing it, since it is usually a fluff acknowledgement ("Ty for all the detail, the screenshots help a lot.").

## Scripts

- `scripts/lint-draft.mjs`: run `node ~/.claude/skills/writing-in-voice/scripts/lint-draft.mjs <draft-file>` (or pipe the draft on stdin) on every draft; the published path adds `--longform`.
