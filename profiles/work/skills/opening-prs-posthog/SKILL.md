---
name: opening-prs-posthog
description: "Extends /opening-prs on a work machine with PostHog's PR conventions, the writing-longform pass on the body, PostHog visual-evidence uploads, and a closing Slack message for the product area's channel. Use when /opening-prs loads work-machine extensions; invoke /opening-prs instead of this skill."
---

# Open PR: PostHog

PostHog opens pull requests early and often, so reviewers can steer work before it hardens. The core skill reads each repo's conventions; this extension adds work-only prose, visual evidence, and a team announcement.

## Step 4: visual evidence

Follow [references/visual-evidence.md](references/visual-evidence.md) together with the core skill's evidence reference.

## Step 5: prose

Load `/writing-longform` beside `/writing-in-voice` before drafting any prose. Its work doc rules set the shape: answer first, numbers over vague quantities, and no machine-writing tells. Where it conflicts with `writing-in-voice`'s casual quirks, `writing-longform` wins.

## Step 7: Slack message

After the PR is posted, print a short message the carbon unit can paste into the channel named above the block, in a fenced code block so it copies cleanly. Leave sending it to the carbon unit.

Name the channel to post in, as `#channel-name`, on the line above the block. The right channel is the one where PRs for the touched product area already get posted, and that often isn't the carbon unit's own team channel. Find it with the Slack MCP's `slack_search_public`: search the product's name together with `github.com/PostHog`, look at the last two months, and give the carbon unit's own past posts first weight. Name only a channel the search returned. When the search finds none, say so and ask the carbon unit.

The team posts PRs as one casual sentence, not a restated PR body, so match that. Write it with `/writing-in-voice`.

- Lead with the bare PR link, e.g. `https://github.com/org/repo/pull/123`: the composer does not render `<url|label>`, but Slack autolinks and unfurls a bare URL.
- One sentence on what it changes, in the reader's words, not how. That sentence is the whole message: keep feedback questions, evidence, risk, and requests such as "quick stamp?" in the PR body, since posting the link is the ask. Repeating the questions in Slack splits the answers across two places.
- One workspace emoji where it fits the subject. Find it with the Slack MCP's `slack_search_emojis` (name substring search, e.g. `wizard` finds `:pet_wizard:`) rather than guessing a name, since a custom emoji that does not exist renders as literal text.
- Link every companion PR this run opened or cited in other repos (the backend or config change it depends on), plus the issue it closes and the stack tip or base PR ("review the stack as a whole"), as bare URLs after the sentence.
- Leave out thanks, credits, @-mentions, caveats, and side stories. The PR body holds those.

```
https://github.com/PostHog/posthog.com/pull/20413 gives the pocket guides setup command the same wizard button :pet_wizard: as the docs install pages instead of the plain grey box.
```

```
https://github.com/PostHog/wizard/pull/1322 adds `wizard feature-flags`, which creates example backend and frontend flags and wires up their evaluation :bufo-gives-you-a-feature-flag: (gateway allowlist: https://github.com/PostHog/charts/pull/16288)
```

Update mode: the sentence says what changed since the last post, e.g. "retry questions answered in thread, ready for review".
