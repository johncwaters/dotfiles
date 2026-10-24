---
name: posting-sprint-updates
description: "Drafts and posts the carbon unit's comment on their team's weekly `[SPRINT]` GitHub issue (PostHog/company-internal, label `sprint`) from their real PRs, the issue template, and past ratings, in their voice and at the team's length. Shows the draft and posts or edits the comment only on an explicit go-ahead. Run it every Monday. Use for \"fill out the sprint issue\", \"sprint update\", \"retro post\", or a link to a `[SPRINT]` issue."
---

# Sprint Update

Teammates skim these in a minute. The user's first full draft ran 532 words and was cut to about 250 to match the team; they then deleted a request to tag a teammate, because they wanted to answer that question themselves. Short, sourced, and nobody tagged is the target.

## Step 1: Find the issue

- If the user gave a link or number, use it.
- Otherwise run `gh issue list -R PostHog/company-internal --label sprint --assignee @me --state open --json number,title,createdAt`, then take the newest.
- Read it with `gh issue view <n> -R PostHog/company-internal --json title,body,createdAt,comments`. The template lives in the body's code fence. The body names the previous sprint issue.
- The user's sprint update is the comment authored by `gh api user --jq .login` whose body contains the template's `## Retro` heading. If one exists, record its `url`; this run edits that comment instead of adding a second one. Other comments by the user are thread replies and stay untouched.

## Step 2: Gather facts

- **Window:** from the previous sprint issue's `createdAt` to now.
- **Work:** run `gh search prs --owner PostHog --author @me --created ">=<window start>" --limit 100 --json repository,number,title,state,url`, then the same search with `--merged-at ">=<window start>"` in place of `--created`, and merge the two lists without duplicates. Include issues the user opened in the same window.
- **Teammates:** read their comments on this issue and on the last three sprint issues, to calibrate length and tone. The team lead's comment is the length reference, or the shortest typical teammate comment if the lead has not commented.
- **Rating:**
  - Read the user's own past ratings with the same lookup.
  - Propose one grounded in what shipped against what stalled, plus a short jokey reason in the team's style: a number plus a few jokey words.
  - If a past rating was a joke, a callback is welcome.
  - The user confirms the rating.
- **Bets:** before stating any claim about a system, team, or vendor, search Slack for recent context after the window start, public channels first. Use `slack_search_public_and_private` only when public channels come up short, and note the source channel of any claim that relies on a private channel or DM. Verify every number with a query. A capped list result is not a count.
- **Calendar:** read the sprint week (Monday to Friday) from the Google Calendar connector. Offsites, OOO, holidays, and all-day events shape Plans and Updates. If the connector's tools are not loaded, say so once and ask the user instead.
- **Ask the user** only for what GitHub, Slack, and the calendar cannot show: handoffs, and work that lives outside PRs.

## Step 3: Draft

Load `writing-in-voice` and write in it.

- Keep the template headings and its `>` prompt lines exactly as written.
- Stay near 250 words, capped at 300. Aim for 3 to 5 progress bullets, 1 or 2 bets, and 2 to 4 plans.
- Group PRs by theme. Link only unfinished items.
- Drop anything handed off to someone else.
- During an offsite or holiday, list it first in Plans, shrink the rest to match, and add a one-line note under Updates.
- @-mention someone only when the carbon unit asks.

## Step 4: Verify every claim

The first full run claimed a NUL-byte fix from a closed, unmerged PR, and called an eval "promising" from a Slack post while its PR reported a failing run. Re-check the finished draft, one claim at a time, against the primary source:

- Each PR: `gh pr view` for state and merge date. Closed is not merged, and done means merged inside the window.
- Each number or result: the PR body, the code, or a fresh query. A Slack message is a lead, not proof; when the PR or code says otherwise, the PR or code wins.
- Each joke in the rating rests on a fact that also passes this check.
- Facts the user stated stay as stated.

Fix or drop every claim that fails, then list the corrections for the user when showing the draft.

## Step 5: Show, then post

- Save the draft in the scratchpad and show it in full, with each private-channel or DM source noted next to its claim so the user confirms it. Strip those notes from the file before posting.
- Post only when the user says to:
  - New comment: `gh issue comment <n> -R PostHog/company-internal --body-file <path>`.
  - Edit: `gh api -X PATCH repos/PostHog/company-internal/issues/comments/<id> -F body=@<path>`, where `<id>` is the number after `#issuecomment-` in the url recorded in Step 1. Use the recorded comment id rather than `--edit-last`: that flag rewrites the carbon unit's newest comment, which may be a thread reply.
- Return the comment URL.
- After the user says they edited the posted comment, fetch it, diff it against the draft, and report what they changed. When the change looks like a lasting preference, propose the skill change for the user's explicit approval; edit this skill only after that approval, since others can edit that comment.
