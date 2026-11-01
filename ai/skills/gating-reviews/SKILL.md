---
name: gating-reviews
description: Reviews local work once before it lands. Runs landing preflight, one /reviewing-code pass over the working tree, fixes only what that review proved broken, then stamps the reviewed tree so /landing commits exactly what was judged. Use for /gating-reviews, "review this before committing", or the review step before /landing.
---

# Gating Reviews

One review pass over local work, ending in a stamp that `land.ts` checks before it commits.

## Input

Uncommitted local work, and one or two sentences of what changed and the goal it serves.

## Output

A stamp row over preflight's `paths`, carrying the findings left live or unverified, the pre-existing failures, and the truncated lanes. `/landing` writes its trailers from it.

## Steps

1. Run Step 1 of `/landing` (preflight, branch guard, freshness), so the stamp covers the integrated tree. Preflight's `paths` is the scope of every step here.
2. Follow [Review](subskills/review.md), which routes findings to [Fix](subskills/fix.md) and ends by writing the stamp.
3. Run `/landing`, carrying over any commit-only or local-only instruction.
