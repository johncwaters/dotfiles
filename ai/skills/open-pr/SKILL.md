---
name: open-pr
description: Open or update a GitHub pull request in any repo with a "Feedback wanted" block at the top of the description section that tells reviewers what stage the work is at and what kind of feedback helps now (design, UI/UX, polish, or merge review), then prints a short Slack message linking the PR for the team channel. Defaults follow PostHog's early-and-often practice; the repo's own PR template, instruction files, and PR skills win over them. Commits uncommitted work through /commit first so it is reviewed. Opens as a draft by default and confirms the body before anything is posted. Use for /open-pr, "open a PR", "put up a draft", "get early feedback on this", or moving an existing PR to a new feedback stage.
---

# Open PR

The defaults here come from PostHog's practice of opening pull requests early and often, so reviewers can steer work before it hardens. An early PR only helps if the reviewer knows what to look at: a design review read like a merge candidate drowns in nits, and a merge candidate reviewed like a sketch ships unreviewed edge cases. Every PR this skill writes therefore carries a `Feedback wanted` block.

Each repo owns its PR conventions and they differ, even across PostHog repos. The repo's rules always win over this skill's defaults. The one thing this skill adds everywhere is the feedback block.

## Step 1: Preconditions

- Uncommitted changes: invoke `/commit` as commit-only, so it runs its review loop, commits, and pushes the feature branch without `--promote` (promotion would land the work on mainline and leave nothing to open a PR for). Its branch guard moves work off mainline onto a feature branch. Skip its closing `/open-pr` offer, since this run is that PR. Continue only on `COMMITTED` with `pushed: true`; any other outcome stops this run with that outcome relayed. This skill never commits or pushes itself.
- Branch is mainline: stop. A PR needs a feature branch.
- Remote branch missing or not at local HEAD (`git fetch origin <branch>`, then `git rev-parse HEAD` differs from `git rev-parse origin/<branch>`): stop and ask the carbon unit to push. Reviewers see only what was pushed, and `/commit` on a clean tree pushes nothing.
- `gh pr view --json number,url,body,isDraft,state,author` finds a PR for this branch with state `OPEN`: this run is update mode. A merged or closed PR does not count; open a new one. Record the mode and act on it only after Step 2.

## Step 2: Load the repo's PR rules

Collect all of these before drafting or touching an existing PR; each can override a default below.

- **Template:** the first of `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/pull_request_template.md`, `pull_request_template.md`, or a file in `.github/PULL_REQUEST_TEMPLATE/`. Several files there: ask which one fits. Its HTML comments are the repo's instructions to authors and agents.
- **Instruction files:** PR, issue, commit, push, and merge sections of `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md` at the repo root. They set title format, required sections, body order, pre-push checks, and merge rules.
- **Repo skills:** any skill those files name for PR work (for example `/writing-pr-descriptions`, `/reviewing-with-coderabbit`, `/stacking-prs` in `PostHog/posthog`), found under `.claude/skills` or `.agents/skills`. Invoke each one where the repo says to. A repo description skill owns the body's shape; this skill only supplies the feedback block content.

Obey what they say: exact section structure, title format, body order (a required lead such as an executive summary comes first), agent context sections, duplicate-PR search, checklist boxes, draft default. Never tick a checklist box for something not done. A template section with nothing to say gets one line or "None".

Stop instead of opening or editing a PR when:

- The repo says this kind of work belongs in an issue, not a PR (`PostHog/posthog.com` routes bugs and non-content changes to issues and closes such PRs). Say so and name the rule.
- The repo says a PR cannot be submitted without screenshots of a visual change and there are none. Name the rule.

Update mode on a PR whose `author.login` differs from `gh api user --jq .login`: when the repo says updates to someone else's PR are appended rather than edited in place, append the feedback block at the end of the body after a `---` line and leave the rest untouched.

No template and no rules: use `Problem`, `Changes`, `How did you test this code?`, and `type(scope): description` for the title.

## Step 3: Pick the feedback stage

Read the diff against the merge-base (`git diff $(git merge-base origin/<mainline> HEAD)`) and the commit log, then recommend one stage:

| Stage | Signals | Reviewers look at |
|---|---|---|
| Design review | Early or stubbed diff, interfaces or schema new, tests thin | Interfaces, data model, module boundaries, migrations |
| UI/UX feedback | Frontend files changed (`.tsx`, `.scss`, `.css`, stories) | Flow, layout, copy, interaction, empty and error states |
| Polish | Feature complete, tests present, CI expected green | Edge cases, naming, test gaps, readability |
| Ready to merge | Polish done, the carbon unit asks for approval | Everything; approve or request changes |

Ask the carbon unit with AskUserQuestion: the recommended stage first, marked "(Recommended)", with the signal that drove it in the description. One stage only; a PR asking for everything gets nothing specific.

## Step 4: Draft the questions

Write 1 to 3 concrete questions a reviewer can answer in a sentence each. Mine them from the diff: open TODOs, a dependency added, a threshold picked without evidence. "Any feedback?" is not a question; "Retries live in the task queue so a crashed client loses nothing; any caller that breaks?" is. The approach is the author's call: state the pick and why, never ask reviewers to choose it, since reviewers stall on an open choice and move on a stated one. Questions the carbon unit supplies win over mined ones.

UI/UX stage: screenshots or a recording are required. Use the repo's upload path where it names one (`hogli pr:upload-image <file>` in `PostHog/posthog`, whose assets are public forever, so never upload customer data or anything internal). No way to capture the UI: say so in the feedback block rather than skipping it, unless Step 2 found a repo rule that makes missing screenshots a blocker, which stops the run.

## Step 5: Build the body

Put the feedback block at the top of the template's main description section: the first of `Problem`, `Overview`, `Motivation and Context`, or `Changes` the template has, or `Problem` with no template. A lead line the repo's rules require first stays above it. Never add a new `##` heading; `PostHog/posthog` forbids changing a template's section structure.

```markdown
## Problem

**Feedback wanted: design review.** Retries move into the task queue so a crashed client loses nothing.

- Any caller that relies on client-side retries?
- Polling every 30s keeps this off webhooks for now; does any consumer need fresher data?
```

Never add a `Skip for now` list or any other list of what reviewers should ignore: the stage name and the questions already scope the review. Update mode drops such a list from the block it replaces.

New PR: fill the rest of the template under the rules from Step 2, then delete every template HTML comment. Testing claims state only what was actually run in this session or by the carbon unit; never claim manual testing that did not happen.

Update mode: replace only the existing feedback block, or add it where a new PR would put it, and keep every other byte of the body, since it may hold screenshots, links, and ticked boxes a carbon unit added. The append-only rule from Step 2 overrides placement.

## Step 6: Confirm and apply

Opening or editing a PR notifies people, so wait for approval before posting. New PR: show the title, draft state, and full body. Update mode: show the diff between the current body and the new one, plus any draft-state change.

- New PR, every stage except Ready to merge: `gh pr create --draft --title "<title>" --body-file -`, body on stdin.
- New PR, Ready to merge: `gh pr create` without `--draft`.
- Update mode: `gh pr edit <number> --body-file -`, body on stdin. Ready to merge on a draft: `gh pr ready <number>`. Any lower stage on a PR that is not a draft: `gh pr ready <number> --undo`.
- Never merge or enqueue.
- The rules ask for an assignee or labels: resolve the handle from `gh api user --jq .login` and pass `--assignee`/`--label`; never guess a handle.

Report the PR URL and the stage it was opened or moved to.

## Step 7: Slack message

After the PR is posted, print a short message the carbon unit can paste into their team channel, in a fenced code block so it copies cleanly. Never post it; the carbon unit sends it.

The team posts PRs as one or two casual lines, not a restated PR body, so match that. Write it with `/voice-style`.

- Lead with the bare PR link, e.g. `https://github.com/org/repo/pull/123`: the composer does not render `<url|label>`, but Slack autolinks and unfurls a bare URL.
- One line on what it does and why it matters to the team, not how.
- Evidence in one short sentence when it helps, e.g. "Passing on next.js, django and rails."
- The ask, sized to the stage: "quick stamp?" for Ready to merge, "Feedback wanted: <the Step 4 questions joined into one sentence>?" for earlier stages. Inline, never bullets.
- Risk in one clause when it helps a reviewer say yes fast, e.g. "no behavior change, safe to release".
- Extra links only when they save a reviewer a click: the issue it closes, the stack tip or base PR ("review the stack as a whole"), a specific diff line that matters most, the preview or screenshot.
- Leave out thanks, credits, @-mentions, and side stories (what the change already caught, what got fixed elsewhere). The PR body holds those.

```
https://github.com/PostHog/wizard/pull/1293 digs a trench around the agent so we can add ESLint import boundaries later. no behavior change, safe to release. quick stamp?
```

```
https://github.com/PostHog/wizard-workbench/pull/4189 drops the copied feature-flags apps for pointers to the basic-integration ones, and the e2e now checks the flags actually got made and wired right. Passing on next.js, django and rails. Feedback wanted: is a separate source.json the right pointer and are these the right checks?
```

Update mode: the message says what changed since the last ask, e.g. "moved to polish, approach settled in thread".
