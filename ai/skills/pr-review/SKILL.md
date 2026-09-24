---
name: pr-review
description: Review a GitHub pull request and optionally post the result to it. Resolves the PR to a base and head SHA without touching the working tree, runs one code-review pass over that range, then asks before posting one batched review of inline comments. Never fixes anything, never loops, never pushes. Use when asked to review a PR, review somebody's changes, or leave review comments on GitHub.
---

# PR Review

The pull request entry point of the review ladder. It reviews somebody's work and leaves a record; it never changes the work.

## When to use

- Reviewing another carbon unit's pull request, which is the case this exists for
- Leaving an audit record on a pull request the local flow already opened, when asked

Reviewing your own uncommitted work is not this skill. That is `/commit`, which loops a review against a writer until the tree is clean. This skill has no writer and therefore no loop.

## Step 1: Resolve the pull request

Accept a PR number, a PR URL, or nothing (meaning the PR for the current branch).

```
gh pr view <pr-or-blank> --json number,url,title,body,baseRefName,headRefName,headRefOid,author,isDraft
```

Fetch the refs so the lanes can run git locally, without checking anything out. Never `gh pr checkout`: it mutates the working tree, and the tree may belong to work in progress that is not yours.

```
git fetch origin "pull/<number>/head:refs/remotes/pr/<number>"
git fetch origin "<baseRefName>"
BASE_SHA=$(git merge-base "origin/<baseRefName>" "refs/remotes/pr/<number>")
HEAD_SHA=<headRefOid>
```

`merge-base` and not the base branch tip: diffing against the tip includes every commit that landed on the base since the PR forked, and those are not this PR's changes to review.

No PR found: say so and stop. Do not silently fall back to reviewing the working tree; that reviews a different thing than the carbon unit asked about.

## Step 2: Review

Invoke `/code-review` with the base and head SHAs, the repo path, and context assembled from the PR itself: title, body, author, and target branch. That context is the only thing standing in for the intent behind a change you did not write, so pass it verbatim rather than summarized.

`/code-review` returns a `VERDICT`, an `ACTIONABLE` count, a dispositioned `STRUCTURED_FINDINGS` block, and a summary. That is the whole review.

`VERDICT: FAILED` means the review did not complete. Re-run it once, since the usual cause is a dead lane process rather than anything about the code. Failing twice: report the failure and post nothing. Posting a partial review as though it were a complete one misrepresents how much of the pull request was actually looked at.

**The `ACTIONABLE` count and disposition change nothing here.** They gate a loop, and this skill has no loop: no writer runs, nothing is fixed, and no round two happens. A disposition on somebody else's pull request is advice about what the author should do, and it becomes the tone of the comment rather than an instruction to this session.

`AMBIGUOUS` findings still get posted, phrased as the open question they are, with both readings stated. They are frequently the most useful comment on a pull request.

## Step 3: Ask before posting

Posting is outward-facing, attributed, and hard to retract. Ask every run, including a re-review of a PR already commented on, and including a PR the local flow just opened.

Show the verdict and the finding counts by severity first, so the answer is informed. Declined: the terminal report from Step 5 is the whole output.

Never post on a draft PR without saying it is a draft and asking anyway.

## Step 4: Post the review

Post every finding with a real file and line as one batched review, not one API call per finding. Batching is not cosmetic: one review sends one notification, N individual comments send N.

`gh api -f` only sets flat string fields, so the comment array must arrive as a real JSON body through `--input`:

```
cat > <body.json> <<'JSON'
{
  "event": "COMMENT",
  "body": "<review body>",
  "commit_id": "<HEAD_SHA>",
  "comments": [
    { "path": "<file>", "line": <line>, "side": "<RIGHT or LEFT, from the finding>", "body": "<comment body>" }
  ]
}
JSON
gh api repos/{owner}/{repo}/pulls/{number}/reviews --method POST --input <body.json>
```

`side` is copied straight from the finding's own `side` field, never inferred here: by the time a finding reaches this step the diff is no longer in hand, and guessing puts a comment about deleted code onto whatever unrelated line now occupies that number. A finding with no `side` is `RIGHT`. A finding whose `line` is `general` has no anchor at all and goes in the review `body`.

Build that JSON with a script (`jq`, or `json.dumps` over the finding list), never by hand-splicing finding text into the template. Bodies contain quotes, backticks, and newlines, and a hand-built body produces invalid JSON or a mangled comment.

`event` stays `COMMENT`. Never `APPROVE` or `REQUEST_CHANGES`: those are the carbon unit's call to make under their own name, and an automated pass must not spend a human's review approval.

Failure of the batched call falls back to `gh api repos/{owner}/{repo}/pulls/{number}/comments` per anchored finding, plus one `reviews` call with the review body and no `comments` when there are `line: general` findings (the `comments` endpoint needs a path and line, so they would otherwise be lost), and the report says the fallback was used.

Each inline body:

```
> [!NOTE]
> Automated review. Not written by a human.

**[<reviewer tag>] <SEVERITY>**

<the finding body>
```

Convergent findings use `**[convergent: <tag> + <tag>] <SEVERITY>**`.

No separate top-level summary comment: the review is the whole record, and a second bot comment per PR is noise. The review `body` is the same `> [!NOTE]` disclaimer, then `Verdict: <VERDICT>`, then one bullet per `line: general` finding in the same tagged format, then `See inline comments.` only when there are inline comments.

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

## Never

- No file edits, no writer, no fix loop. Reviewing somebody's work does not include doing it
- No `git` writes beyond `fetch`, and no checkout
- No `APPROVE` or `REQUEST_CHANGES` review events
- No posting without asking first
