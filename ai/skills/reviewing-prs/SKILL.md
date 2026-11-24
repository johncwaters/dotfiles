---
name: reviewing-prs
description: Reviews a GitHub pull request and optionally posts the result to it. Resolves the PR to a base and head SHA without touching the working tree, runs one reviewing-code pass over that range, then asks before posting one batched review of inline comments. Fixes nothing, runs one pass, and pushes nothing. Use when asked to review a PR, review somebody's changes, or leave review comments on GitHub.
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node $HOME/.claude/hooks/engine-gate.mjs"
---

# PR Review

The pull request entry point of the review ladder. It reviews somebody's work and leaves a record; it leaves the work intact.

## Input

- Reviewing another carbon unit's pull request, which is the case this exists for
- Leaving an audit record on a pull request the local flow already opened, when asked

Reviewing your own uncommitted work is not this skill. That is `/gating-reviews`, which runs one review and a writer that re-runs each finding's proof.

## Step 1: Resolve the pull request

Accept a PR number, a PR URL, or nothing (meaning the PR for the current branch).

```
gh pr view <pr-or-blank> --json number,url,title,body,baseRefName,headRefName,headRefOid,author,isDraft
```

Fetch the refs so the lanes can run git locally, keeping the working tree intact rather than running `gh pr checkout`: checkout mutates the working tree, and the tree may belong to work in progress that is not yours.

```
git fetch origin "pull/<number>/head:refs/remotes/pr/<number>"
git fetch origin "<baseRefName>"
BASE_SHA=$(git merge-base "origin/<baseRefName>" "refs/remotes/pr/<number>")
HEAD_SHA=<headRefOid>
```

`merge-base` and not the base branch tip: diffing against the tip includes every commit that landed on the base since the PR forked, and those are not this PR's changes to review.

No PR found: say so and stop, keeping the working tree outside the review; it is a different thing than the carbon unit asked about.

## Step 2: Review

Invoke `/reviewing-code` with the base and head SHAs, the repo path, and context assembled from the PR itself: title, body, author, and target branch. That context is the only thing standing in for the intent behind a change you did not write, so pass it verbatim rather than summarized.

`/reviewing-code` returns a `VERDICT`, an `ACTIONABLE` count, a dispositioned `STRUCTURED_FINDINGS` block, and a summary. That is the whole review.

No diff is too small, too familiar, or too docs-only to skip `/reviewing-code`, re-reviews included: a hand read is not this review, and the `engine-gate.mjs` Stop hook sends a run that stops before launching the engine back to this step.

`VERDICT: FAILED` means the review did not complete. Re-run it once, since the usual cause is a dead lane process rather than anything about the code. Failing twice: report the failure and post nothing. Posting a partial review as though it were a complete one misrepresents how much of the pull request was actually looked at.

**The `ACTIONABLE` count and disposition change nothing here.** They gate a writer, and this skill has none: nothing is fixed. A disposition on somebody else's pull request is advice about what the author should do, and it becomes the tone of the comment rather than an instruction to this session.

`AMBIGUOUS` findings still get posted, phrased as the open question they are, with both readings stated. They are frequently the most useful comment on a pull request.

## Step 3: Ask before posting

Posting is outward-facing, attributed, and hard to retract. Ask every run, including a re-review of a PR already commented on, and including a PR the local flow just opened.

Show the verdict and the finding counts by severity first, so the answer is informed. Declined: the terminal report from Step 5 is the whole output.

For a draft PR, say it is a draft and ask before posting.

The comments post as the carbon unit, so write each one with `writing-in-voice` on its published path before showing them.

## Step 4: Post the review

Post every finding with a real file and line as one batched review, not one API call per finding. Batching is not cosmetic: one review sends one notification, N individual comments send N.

`gh api -f` only sets flat string fields, so the comment array must arrive as a real JSON body through `--input`, a `<body.json>` of this shape:

```
{
  "event": "COMMENT",
  "body": "<review body>",
  "commit_id": "<HEAD_SHA>",
  "comments": [
    { "path": "<file>", "line": <line>, "side": "<RIGHT or LEFT, from the finding>", "body": "<comment body>" }
  ]
}
```

```
gh api repos/{owner}/{repo}/pulls/{number}/reviews --method POST --input <body.json>
```

`side` is copied only from the finding's own `side` field: by the time a finding reaches this step the diff is no longer in hand, and guessing puts a comment about deleted code onto whatever unrelated line now occupies that number. A finding with no `side` is `RIGHT`. A finding whose `line` is `general` has no anchor at all and goes in the review `body`.

Build that JSON only with a script (`jq`, or `json.dumps`) that reads the findings from the `REVIEW_FILE` `/reviewing-code` returned, keeping finding text out of hand-spliced templates and out of the Bash command, where Safety Net blocks a finding that names a secret path. Bodies contain quotes, backticks, and newlines, and a hand-built body produces invalid JSON or a mangled comment.

`event` stays `COMMENT`, reserving `APPROVE` and `REQUEST_CHANGES` for the carbon unit under their own name; an automated pass leaves their review approval unspent.

Failure of the batched call falls back to `gh api repos/{owner}/{repo}/pulls/{number}/comments` per anchored finding, plus one `reviews` call with the review body and no `comments` when there are `line: general` findings (the `comments` endpoint needs a path and line, so they would otherwise be lost), and the report says the fallback was used.

Each inline body:

```
**[<reviewer tag>] <SEVERITY>**

<the finding body>

<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>
```

Convergent findings use `**[convergent: <tag> + <tag>] <SEVERITY>**`.

No separate top-level summary comment: the review is the whole record, and a second bot comment per PR is noise. The review `body` is `Verdict: <VERDICT>`, then one bullet per `line: general` finding in the same tagged format, then `See inline comments.` only when there are inline comments, then `<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>`.

## Step 5: Report

Terminal report regardless of whether anything was posted:

```
## PR #<n> <title>
Verdict: <VERDICT>   Actionable: <n>   Range: <BASE_SHA>..<HEAD_SHA>   Files: N   Lines: N
Lanes: <tag>, <tag>   Degraded: <tag> (<reason>)
Findings: <n> CRITICAL, <n> HIGH, <n> MEDIUM, <n> LOW, <n> NIT
Posted: <yes, N inline + M in review body | no, declined> (fallback used, when it was)

### Findings
- path:line [SEVERITY] [<tag>] problem. fix.
(most severe first; convergent findings marked)
```

## Boundaries

- No file edits, no writer, no fix loop. Reviewing somebody's work does not include doing it
- No `git` writes beyond `fetch`, and no checkout
