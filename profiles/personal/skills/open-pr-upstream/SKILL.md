---
name: open-pr-upstream
description: "Extends /open-pr on a personal machine with the open-source contribution flow: forking, issue-first changes, CLA and DCO sign-off, AI-use policies, and writing for unfamiliar maintainers. Use when /open-pr loads personal-machine extensions; invoke /open-pr instead of this skill."
---

# Open PR: upstream contributions

Maintainers of someone else's project owe the carbon unit nothing, so a contribution lands when it is easy to say yes to: agreed in advance, small, signed off, and readable cold.

## Step 1: fork

`gh repo view --json viewerPermission` below `WRITE` on origin means the work needs a fork. Ask the carbon unit first, since a fork is a new public repo on their account. Then run `gh repo fork --remote`: origin becomes the fork and the project becomes `upstream`. Rebase the branch onto `upstream/<default branch>` before `/commit` pushes it.

## Step 2: contribution rules

- **Issue first.** Anything beyond a typo, a docs fix, or a bug fix with a test needs an issue or discussion where a maintainer agreed to the change. With none, recommend opening the issue first and offer to draft it. Link the agreed issue with `Fixes #<n>` in the body.
- **DCO.** A `DCO` check, `.github/dco.yml`, or a CONTRIBUTING sign-off rule means every commit carries `Signed-off-by: <name> <email>` from `git config user.name` and `user.email`. Check with `git log --format=%B <base>..HEAD`; add a missing trailer with `git rebase --signoff <base>` and push through `/commit`.
- **CLA.** A CLA bot or CONTRIBUTING rule needs the carbon unit's own signature. Name the link and let them sign it.
- **AI use.** Follow the repo's AI policy exactly, including its disclosure wording. A repo that refuses AI-assisted contributions stops the run; name the rule.

## Step 3: stage

Outside maintainers rarely read drafts. Recommend Polish or Ready to merge, both opened ready for review, unless the repo invites drafts. A change that needs a Design review belongs in its issue or discussion first.

## Step 5: body

Write for a reader with no context: what broke or was missing, the fix, and how it was tested, each in a sentence or two. The body names no private repos, work projects, or internal tooling.

## After Step 6

Report any CLA, DCO, or contributor-check bot comment that appears on the PR, along with what it asks the carbon unit to do.
