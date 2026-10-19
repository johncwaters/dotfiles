---
name: open-pr-posthog
description: Extension for /open-pr on a work machine. Adds PostHog's PR conventions, the longform-writing pass on the body, PostHog visual-evidence uploads, and a closing Slack message for the team channel. Loaded by /open-pr itself; invoke /open-pr instead of this skill.
---

# Open PR: PostHog

PostHog opens pull requests early and often, so reviewers can steer work before it hardens. That is why the core skill defaults to drafts and always writes a status block. Each PostHog repo still owns its conventions, and they differ between repos.

## Step 2: PostHog repo rules

- `PostHog/posthog` names PR skills such as `/writing-pr-descriptions`, `/reviewing-with-coderabbit`, and `/stacking-prs`. Invoke each one where the repo says to. The repo forbids changing a template's section structure, so the status block never gets its own `##` heading.
- `PostHog/posthog.com` routes bugs and non-content changes to issues and closes such PRs. A visual change spanning several pages also goes to an issue, and a PR that goes ahead anyway says why in its description.

## Step 4: visual evidence

Follow [references/visual-evidence.md](references/visual-evidence.md) together with the core skill's capture guide.

## Step 5: prose

Load `/longform-writing` beside `/voice-style` before drafting any prose. Its work doc rules set the shape: answer first, numbers over vague quantities, and no machine-writing tells. Where it conflicts with voice-style's casual quirks, longform-writing wins.

## Step 7: Slack message

After the PR is posted, print a short message the carbon unit can paste into their team channel, in a fenced code block so it copies cleanly. Never post it; the carbon unit sends it.

The team posts PRs as one casual sentence, not a restated PR body, so match that. Write it with `/voice-style`.

- Lead with the bare PR link, e.g. `https://github.com/org/repo/pull/123`: the composer does not render `<url|label>`, but Slack autolinks and unfurls a bare URL.
- One sentence on what it changes, in the reader's words, not how. That sentence is the whole message at every stage: no feedback questions, evidence, risk, or "quick stamp?", since the PR body's status block carries them and posting the link is the ask. Repeating the questions in Slack splits the answers across two places.
- One workspace emoji where it fits the subject. Find it with the Slack MCP's `slack_search_emojis` (name substring search, e.g. `wizard` finds `:pet_wizard:`) rather than guessing a name, since a custom emoji that does not exist renders as literal text.
- Link every companion PR this run opened or cited in other repos (the backend or config change it depends on), plus the issue it closes and the stack tip or base PR ("review the stack as a whole"), as bare URLs after the sentence.
- Leave out thanks, credits, @-mentions, caveats, and side stories. The PR body holds those.

```
https://github.com/PostHog/posthog.com/pull/20413 gives the pocket guides setup command the same wizard button :pet_wizard: as the docs install pages instead of the plain grey box.
```

```
https://github.com/PostHog/wizard/pull/1322 adds `wizard feature-flags`, which creates example backend and frontend flags and wires up their evaluation :bufo-gives-you-a-feature-flag: (gateway allowlist: https://github.com/PostHog/charts/pull/16288)
```

Update mode: the sentence says what changed since the last post, e.g. "moved to polish, approach settled in thread".
