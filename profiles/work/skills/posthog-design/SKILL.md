---
name: posthog-design
description: "Supplies the taste for UI in any PostHog repo, which the design skill resolves to there. Use when building, styling, or reviewing frontend in a PostHog repository (the PostHog app, posthog.com, or another PostHog project). Points at the repo's own design system; the design skill owns the process."
---

# PostHog design

PostHog's components and tokens live upstream, in each repo. Read them there; this skill holds no copies.

1. Find the repo's own design system before writing UI. In the PostHog app (`PostHog/posthog`) that is Lemon UI under `frontend/src/lib/lemon-ui`, with Storybook stories beside the components, `colors.stories.tsx` included. Other PostHog repos keep their own component library; locate it the same way.
2. Build from existing components and tokens. A new pattern starts as a change to the shared component, so every screen meeting that situation picks it up.

## Shared laws the repo overrides

- **theme-scene**: the repo's theme system already sets dark and light; support both themes it ships.
- **motion**: the repo's existing transitions and durations win where they differ.

Every other `design` step applies as written.
