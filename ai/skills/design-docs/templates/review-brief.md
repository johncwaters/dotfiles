# Review brief: <doc title>

Objective: read-only critical review of a doc the author is about to share with <audience>. The author's worries: <numbered list, in their words>.

Scope: the sources listed below, read-only.
Out of scope: editing, committing, running anything that writes.
Definition of done: a report that follows the output contract.

Find gaps: what the doc is missing, what a reviewing teammate will ask that it does not answer, and where its claims are not backed by the code or data.

## Sources (read-only; never edit, commit, or run anything that writes)
- <repo or data path>: <what it holds>

## The doc as it stands (verbatim)

<doc text>

## Output contract (keep under ~900 words)
Ground every claim in the sources: cite `path:line`. Mark anything you could not verify as UNVERIFIED.
1. Gaps against the author's worries, ranked, each with its evidence and a concrete fix.
2. Questions a teammate will ask that the doc does not answer.
3. Claims the code or data contradicts or does not back, with `path:line`.
4. Top 5 edits before sharing, in priority order.
