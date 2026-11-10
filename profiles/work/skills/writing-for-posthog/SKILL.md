---
name: writing-for-posthog
description: "Adds PostHog's writing conventions to the writing-in-voice skill on a work machine: the PostHog house style, posthog.com docs, handbook, tutorial, blog and changelog pages, and the docs reviewers' tells. Use when writing-in-voice loads it before a draft; invoke writing-in-voice instead of this skill."
---

# Writing for PostHog

PostHog is the house style the published path's second influence describes: opinions, candor, precision, and skimmable structure. Readers and reviewers here ask for rewrites when machine-writing tells are obvious, so the core skill's tells list is a hard bar.

## Where it applies

- Prose in a posthog.com `contents/` file or a handbook page takes the published path. Docs pages, tutorials, and pocket guides use the docs-or-tutorial template; blog posts and changelog entries use the blog-or-post template.

## Docs review lessons

PostHog docs reviewers mark the core skill's last four tells (aphorism for fact, decoded contrast pair, dramatized cost, narrated setup) as "Claudish" and send the page back. In docs, keep exact limits, windows, and retention periods out of the prose and link the docs page that owns them, since those numbers change; `lint-draft.mjs --longform` flags a time or request count beside a `/docs` link.
