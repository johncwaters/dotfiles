---
name: longform-writing
description: Draft, edit, or critique long-form writing: blog posts, articles, newsletters, essays, LinkedIn or social posts, launch posts, post-mortems, teaching guides (pocket guides, tutorials, docs pages), PostHog content (posthog.com docs, handbook pages, tutorials, blog posts, changelog entries, RFCs), and work docs like proposals, design docs, PR descriptions, and updates, in a Sorkin-meets-PostHog style (intention and obstacle, rhythm, strong opinions, specifics, no fluff). Use when asked to write, outline, rewrite, tighten, or review a blog, post, article, or doc, when creating or editing prose in a posthog.com `contents/` file or a handbook page, or "make this punchier". Short messages (Slack, email, texts, replies) belong to voice-style instead.
---

# Long-form writing

Two influences, one habit: respect a smart, busy reader. Aaron Sorkin supplies stakes, rhythm, and momentum; PostHog supplies opinions, candor, precision, and skimmable structure. Blogs lean on both. Teaching guides lead with the concept. Work docs lead with the answer and spend at most one Sorkin flourish. When voice-style also fires on a long-form piece, this skill's structure and mechanics win over its casual message quirks (typos, apostrophe plurals, emoticons, idk or lol), while the author's word choice and warmth can still carry over.

## Workflow

1. **Pitch before prose.** Get a one-sentence pitch containing "but", "except", or "and then". No turn in the sentence means no tension and no piece yet. If the carbon unit hasn't supplied the substance (the claim, the numbers, what happened), ask for it rather than inventing it: "having something interesting to say matters more than the title."
2. **Title first.** Specific beats clever: a number, a concrete claim, a real dollar figure. Generic test: if a bland B2B SaaS blog would publish this title, rewrite it.
3. **Draft with the template** that fits (below).
4. **Revise** against the checklist. Rewriting is easier than writing because now there is a problem to solve.
5. **Deliver** the piece, then at most three lines on the choices made and any open questions (missing numbers, unverified claims).

## Blog or post template

1. **Open mid-motion.** First line is the problem already happening. No throat-clearing ("In today's world…", "Have you ever wondered…").
2. **Intention.** What you or the reader wanted. Show it rather than announce it.
3. **Obstacle.** What made it hard. Press on it: if a reader could shrug "that's not that hard of a problem", raise the stakes or cut the piece.
4. **Tactics.** What was tried, in order, with numbers, failures included. Tactics reveal character better than feelings do.
5. **Opinion.** Take a side and give the reasoning. Answer the strongest counter-argument instead of strawmanning it.
6. **Button.** End on a callback to the opening line or the sharpest sentence in the piece. Never a recap.

Short social posts compress this to hook (mid-motion), turn ("but"), payoff (opinion or number), button.

Social post formatting, from the author's own edits to a drafted LinkedIn post:

- One or two sentences per paragraph with a blank line between, because the feed is skimmed on a phone and a four-sentence block reads as a wall.
- Spend the one allowed aside as a casual parenthetical in the author's voice ("only two eyes, duh"), placed right after the claim it deflates; the author adds this when the draft has none.

## Teaching guide template

For pocket guides, tutorials, and docs pages that teach a product concept.

1. **Teach the mental model, not the setup tool.** Explain the concept so a reader who never ran the wizard, CLI, or template follows every page. Artifacts a setup tool created appear only as an optional, conditional example ("If you ran the wizard, …"), never as the frame or the running story.
2. **Follow the concept's lifecycle** (for example, create, roll out, kill, measure, retire) rather than the steps one tool performed.
3. **Open each page on the concept and the decision it serves.** Headings name the job or decision ("Choose where a flag is evaluated"), not the mechanism.
4. **Structure around the reusable decision.** At each step, answer the questions the reader will face again: who is eligible, what signal to watch, what makes them continue or roll back. A table of shapes or options also needs the rule for choosing among them: a decision tree or clear defaults.
5. **Give the full model before the shortcut.** Name every part a correct result needs (an experiment is hypothesis, eligible population, primary metric, and exposure moment, not only a flag with variants) so a partial setup does not read as the whole thing.
6. **Earn each heading.** A heading over one sentence either merges into its neighbor or grows a concrete example, a table, or an annotated visual.
7. **Open without overclaiming.** The opening never promises what a later section qualifies ("off is instant" followed by propagation delays).
8. **Stay consistent across pages.** A categorical claim ("every flag is debt") must agree with exceptions made elsewhere (permanent operational flags); separate the categories where they first appear.
9. **Captions stand alone.** A caption or code intro plainly says what the reader is looking at, with no assumed prior context.
10. **Native formatting first.** Code samples and tables use the platform's native Markdown. Custom figure components are only for visuals Markdown cannot render: annotated mock UI or diagrams. Size screenshots to the page, and prefer an annotated mock UI when it explains more than a raw screenshot.

## Work doc template

1. **The answer.** One sentence: decision, recommendation, or status, with its number or date.
2. **Why now.** Intention and obstacle in two or three sentences.
3. **Reasoning.** Candid and specific, including the best counter-argument and the reply to it.
4. **The ask.** What is needed, from whom, by when.
5. **Optional button.** One memorable line at most.

## Sentence rules

- **Rhythm.** Dialogue is music, and music needs connected phrases, not a drum hit per beat. Most sentences run medium length and link related thoughts with "and", "but", "because", "so", or a colon; a short sentence lands only because the ones around it are longer. Read it aloud in your head; rewrite anything you'd stumble over or that sounds like ad copy.
- **No confusion.** One idea per paragraph. Define a term before riffing on it. Tell the reader what they need to know before being clever.
- **Progress.** Every section ends at least one step further than it started. A section that only restates is cut.
- **Precision.** Name the tool, database, metric, date. Ban "a lot", "soon", "quickly", "better": replace each with a number. Link each external factual claim inline to a primary or first-rate source (the creator's own writing, a developer talk or interview, a credible deep-dive), never an encyclopedia or content farm, and open the page to confirm it supports the claim before linking it. First-hand numbers and internal claims stay unlinked, and so does any claim you can't confirm on an open page: list it with step 5's unverified claims rather than invent a link. The author's own projects link to where a reader can get them.
- **Pick a side.** No "it depends", no "ultimately it's up to you". Have an opinion, give an example, or do the research until you can.
- **Human.** Name the people involved; use real screenshots, chat logs, quotes. Self-deprecating humor where it fits. Never perform emotion ("I was so excited to…"); show the action and let the reader feel it.
- **Concise.** Omit needless words, not the connectives that carry the logic between claims. Cut or halve the intro. No transitions like "Here are five things…", no summary of what the reader just read.
- **Mechanics.** Sentence-case headings, Oxford comma, American spelling, no em-dash decoration. Headings, lists, and tables only where they help a skimming reader.

## Tells that mark prose as machine-written

Readers can tell, and PostHog asks for rewrites when it's obvious. Strip on sight: "delve", "tapestry", "landscape", "game-changer", "unlock", "navigate the complexities"; reflexive triplets; "It's not X, it's Y" more than once per piece; stacked rhetorical questions; a closing "In conclusion" or "Ultimately"; an ending that recaps; uniform sentence length; emoji bullets.

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
- [ ] Teaching guide: a reader who skipped the setup tool follows every page, each step states its reusable decision, no heading sits over one sentence, and code and tables use native Markdown.

## Critique mode

When asked to review rather than write, return findings in checklist order, each as quoted line, problem, rewrite. Lead with the single biggest fix (usually a missing obstacle or a buried answer), and never rewrite the whole piece unasked.
