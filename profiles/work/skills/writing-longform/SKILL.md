---
name: writing-longform
description: "Drafts and edits prose posted as the carbon unit to a team or the public, in a Sorkin-meets-PostHog style: GitHub issues, PR descriptions, issue and PR comments, review replies, docs, tutorials, handbook pages, RFCs, design docs, proposals, blog posts, essays, launch and social posts, changelogs, post-mortems. Use when writing, rewriting, tightening, or reviewing one, even mid-code-task, for prose in a posthog.com `contents/` file, or for \"make this punchier\". Slack, email, and texts go to writing-in-voice."
---

# Long-form writing

Covers blog posts, articles, newsletters, essays, LinkedIn or social posts, launch posts, post-mortems, teaching guides (pocket guides, tutorials, docs pages), PostHog content (posthog.com docs, handbook pages, tutorials, blog posts, changelog entries, RFCs), and work docs (proposals, design docs, PR descriptions, GitHub issues, issue and PR comments, review replies, updates). The style uses intention and obstacle, rhythm, strong opinions, specifics, and no fluff.

Two influences, one habit: respect a smart, busy reader. Aaron Sorkin supplies stakes, rhythm, and momentum; PostHog supplies opinions, candor, precision, and skimmable structure. Blogs lean on both. Teaching guides lead with the concept and spend no flourish. Work docs lead with the answer and spend at most one Sorkin flourish. When `writing-in-voice` also fires on a long-form piece, this skill's structure and mechanics win over its casual message quirks (typos, apostrophe plurals, emoticons, idk or lol), while the author's word choice and warmth can still carry over. A playful social post is the exception, covered under the post template.

## Workflow

1. **Pitch before prose.** Get a one-sentence pitch containing "but", "except", or "and then". No turn in the sentence means no tension and no piece yet. If the carbon unit hasn't supplied the substance (the claim, the numbers, what happened), ask for it rather than inventing it: "having something interesting to say matters more than the title." When they supplied a draft, its facts, nouns, and claims are fixed: reorder and cut, but add no detail they did not write.
2. **Title first.** Specific beats clever: a number, a concrete claim, a real dollar figure. Generic test: if a bland B2B SaaS blog would publish this title, rewrite it.
3. **Draft with the template** that fits under [Templates](#templates).
4. **Revise** against the checklist. Rewriting is easier than writing because now there is a problem to solve.
5. **Lint.** Run `node ~/.claude/skills/writing-in-voice/scripts/lint-draft.mjs --longform <draft-file>`, delete or rewrite each flagged sentence as its output says, and rerun until it exits 0.
6. **Deliver** the piece, then at most three lines on the choices made and any open questions (missing numbers, unverified claims).

## Templates

Read the template that fits the piece:

- [Blog or post](subskills/blog-or-post.md), including short and playful social posts.
- [Teaching guide](subskills/teaching-guide.md) for pocket guides, tutorials, and docs pages.
- Launch posts, pitches, announcements, and demo posts: load `storytelling` for the arc, then apply this skill's sentence rules.
- Work docs: a PR description, GitHub issue, comment, review reply, or status update leads with the answer and ends with the ask; a design doc, RFC, or proposal takes its shape from the `writing-design-docs` skill.

## Sentence rules

- **Rhythm.** Dialogue is music, and music needs connected phrases, not a drum hit per beat. Most sentences run medium length and link related thoughts with "and", "but", "because", "so", or a colon; a short sentence lands only because the ones around it are longer. Read it aloud in your head; rewrite anything you'd stumble over or that sounds like ad copy.
- **No confusion.** One idea per paragraph. Define a term before riffing on it. Tell the reader what they need to know before being clever.
- **Progress.** Every section ends at least one step further than it started. A section that only restates is cut.
- **Precision.** Name the tool, database, metric, date. Ban "a lot", "soon", "quickly", "better": replace each with a number. Link each external factual claim inline to a primary or first-rate source (the creator's own writing, a developer talk or interview, a credible deep-dive), excluding encyclopedias and content farms, and open the page to confirm it supports the claim before linking it. First-hand numbers and internal claims stay unlinked, and so does any claim you can't confirm on an open page: list it with step 6's unverified claims rather than invent a link. The author's own projects link to where a reader can get them.
- **Pick a side.** No "it depends", no "ultimately it's up to you". Have an opinion, give an example, or do the research until you can.
- **Human.** Name the carbon units involved; use real screenshots, chat logs, quotes. Self-deprecating humor where it fits. Show the action and let the reader feel it instead of performing emotion ("I was so excited to…").
- **Concise.** Omit needless words, not the connectives that carry the logic between claims. Cut or halve the intro. No transitions like "Here are five things…", no summary of what the reader just read.
- **Mechanics.** Sentence-case headings, Oxford comma, American spelling, no em-dash decoration. Headings, lists, and tables only where they help a skimming reader.

## Tells that mark prose as machine-written

Readers can tell, and PostHog asks for rewrites when it's obvious. Strip on sight: "delve", "tapestry", "landscape", "game-changer", "unlock", "navigate the complexities"; reflexive triplets; "It's not X, it's Y" more than once per piece; stacked rhetorical questions; a closing "In conclusion" or "Ultimately"; an ending that recaps; uniform sentence length; emoji bullets; a kicker clause tacked onto a plain claim ("you flip the flag off, and nobody waits on a revert"), where the sentence ends on the fact instead ("without needing a revert").

In teaching guides, reviewers flag these as "Claudish", from a PostHog docs review that marked each example below:

- An aphorism standing in for the fact: "A flag at 0% is live code that nobody runs", "A rollout is only as safe as what you watch between steps", `"A kill switch you've never flipped is a kill switch you hope works"`. State the fact or the instruction itself.
- A balanced contrast pair the reader must decode: "A flag decides whether someone gets a feature, and a payload lets it decide how". Say what the thing is: "A feature flag can carry a payload, which …".
- A dramatized cost: "A rollback is a revert, a build, and a deploy, and your users see the bug for as long as all three take". Name the concrete steps plainly.
- A setup line narrating the story's progress: "It's a pretty average conversation, nothing really out of the norm", "Now Twig's engineers have a pretty good understanding of …". Start at the event: "Another visitor reports a bug: …".

## Revision checklist

- [ ] Pitch sentence contains "but", "except", or "and then".
- [ ] Title passes the generic test.
- [ ] Blog or post: intro cut or halved; the piece opens mid-motion.
- [ ] Blog, post, or work doc: intention and obstacle are clear within the first three paragraphs.
- [ ] Every vague quantity is a number.
- [ ] No hedges and no machine-writing tells.
- [ ] Every section moves the argument.
- [ ] At most one clever line per section, and each earns its place (kill your darlings).
- [ ] Blog or post: ends on a button, not a recap.
- [ ] Work doc: the answer is the first sentence.
- [ ] Teaching guide: a reader who skipped the setup tool follows every page, each step states its reusable decision, no heading sits over one sentence, each page opens on a plain statement of what the thing does, no "Claudish" tell survives, and code and tables use native Markdown.

## Critique mode

When asked to review rather than write, return findings in chat as one table, `# | Location | Comment | Suggested text`, in checklist order, leading with the single biggest fix (usually a missing obstacle or a buried answer). "Draft comments" means this table: post nothing to GitHub or anywhere else until the carbon unit asks. Rewrite the whole piece only when asked.
