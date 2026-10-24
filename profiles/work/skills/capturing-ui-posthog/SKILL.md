---
name: capturing-ui-posthog
description: "Extends the capturing-ui skill on a work machine with PostHog's capture conventions: the posthog.com browser-screenshots guide, the fast minimal dev server, and the theme and cookie-banner flags every posthog.com capture needs. Use when the capturing-ui skill loads work-machine extensions; invoke capturing-ui instead of this skill."
---

# Capturing UI: PostHog

Each section applies at the `capturing-ui` section it names. `agents/browser-screenshots.md` in `PostHog/posthog.com` wins over this file.

## Screenshots

- **posthog.com dev server:** `GATSBY_MINIMAL=true PORT=<port> pnpm start` builds pocket guides, docs, and handbook in minutes; wait for `success Building development bundle`.
- **posthog.com capture flags:** `--local-storage '{"theme":"{mode}","siteSettings":{"colorMode":"{mode}","theme":"{mode}"}}'` (both keys, or theme and control disagree) and `--dismiss 'text=Legally-required cookie banner >> xpath=ancestor::*[.//button][1] >> button'`.
