# Published path

GitHub issues, PR descriptions, issue and PR comments, review replies, docs pages, tutorials, RFCs, design docs, proposals, blog and social posts, launch posts, changelogs, post-mortems, and status updates: anything posted where others read it later. The style uses intention and obstacle, rhythm, strong opinions, specifics, and no fluff.

Two influences, one habit: respect a smart, busy reader. Aaron Sorkin supplies stakes, rhythm, and momentum; a candid engineering house style supplies opinions, precision, and skimmable structure. Blogs lean on both. Docs and tutorials lead with the concept and spend no flourish. Work docs (issues, comments, PR descriptions, updates) lead with the answer and spend at most one Sorkin flourish. This path's structure and mechanics win over the message path's casual quirks (typos, apostrophe plurals, emoticons, idk or lol), while the author's word choice and warmth carry over. A playful social post is the exception, covered under the post template.

## Workflow

1. **Pitch before prose.** Get a one-sentence pitch containing "but", "except", or "and then". No turn in the sentence means no tension and no piece yet. If the carbon unit hasn't supplied the substance (the claim, the numbers, what happened), ask for it rather than inventing it: "having something interesting to say matters more than the title." A short comment or review reply skips the pitch and leads with its answer.
2. **Title first.** Specific beats clever: a number, a concrete claim, a real dollar figure. Generic test: if a bland B2B SaaS blog would publish this title, rewrite it. An issue title names the defect and where it lives.
3. **Draft with the template** that fits under [Templates](#templates).
4. **Revise** against the sentence rules and the template's steps. Rewriting is easier than writing because now there is a problem to solve.
5. **Lint** with `--longform`, as the skill's `scripts/lint-draft.mjs` entry says, and rerun until it exits 0.
6. **Deliver** the piece, then at most three lines on the choices made and any open questions (missing numbers, unverified claims). A GitHub comment, review, or review-thread reply an agent posts ends with `<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>` as its last line, the footer Glimmervoid's own reviews carry; `guard-workflow` denies a Claude post without it.

## Templates

Read the template that fits the piece:

- [Blog or post](blog-or-post.md), including short and playful social posts.
- [Docs or tutorial](docs-or-tutorial.md) for docs pages, tutorials, and pocket guides.
- [Launch or pitch](launch-or-pitch.md) for launch posts, pitches, announcements, talks, demos, and README intros.
- Work docs: a PR description, GitHub issue, comment, review reply, or status update leads with the answer and ends with the ask; a design doc, RFC, or proposal takes its shape from the planning skill that loaded this one. Either borrows from the launch arc after the answer: the change framed against the old behavior on a real timeline, the problem as the villain, each number beside a comparison, and each claim beside the output or screenshot that proves it.

## Sentence rules

- **Rhythm.** Dialogue is music, and music needs connected phrases, not a drum hit per beat. Most sentences run medium length and link related thoughts with "and", "but", "because", "so", or a colon; a short sentence lands only because the ones around it are longer. Read it aloud in your head; rewrite anything you'd stumble over or that sounds like ad copy.
- **No confusion.** One idea per paragraph. Define a term before riffing on it. Tell the reader what they need to know before being clever.
- **Progress.** Every section ends at least one step further than it started. A section that only restates is cut.
- **Precision.** Name the tool, database, metric, date. Ban "a lot", "soon", "quickly", "better": replace each with a number. Link each external factual claim inline to a primary or first-rate source (the creator's own writing, a developer talk or interview, a credible deep-dive), excluding encyclopedias and content farms, and open the page to confirm it supports the claim before linking it. First-hand numbers and internal claims stay unlinked, and so does any claim you can't confirm on an open page: list it with step 6's unverified claims rather than invent a link. The author's own projects link to where a reader can get them.
- **Pick a side.** No "it depends", no "ultimately it's up to you". Have an opinion, give an example, or do the research until you can.
- **Human.** Name the carbon units involved; use real screenshots, chat logs, quotes. Self-deprecating humor where it fits. Show the action and let the reader feel it instead of performing emotion ("I was so excited to…").
- **Concise.** Omit needless words, not the connectives that carry the logic between claims. Cut or halve the intro. No transitions like "Here are five things…", no summary of what the reader just read. At most one clever line per section, and only one that earns its place.
- **Mechanics.** Sentence-case headings, Oxford comma, American spelling. Headings, lists, and tables only where they help a skimming reader.

## Critique mode

When asked to review rather than write, return findings in chat as one table, `# | Location | Comment | Suggested text`, in order of impact, leading with the single biggest fix (usually a missing obstacle or a buried answer). "Draft comments" means this table: post nothing to GitHub or anywhere else until the carbon unit asks. Rewrite the whole piece only when asked.
