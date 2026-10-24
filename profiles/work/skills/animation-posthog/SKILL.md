---
name: animation-posthog
description: "Extends the animation skill on a work machine with PostHog's test chamber series conventions, @posthog/brand assets, the PostHog brand pass, and the chamber poster style. Use when the animation skill loads work-machine extensions; invoke animation instead of this skill."
---

# Animation: PostHog

Each section applies at the animation step it names.

## Concept

- The series is the PostHog docs test chambers: `Artifact` `action: "list"` (search titles for "Chamber") plus local copies such as `~/Downloads/posthog-chambers`.
- Take assets from the `@posthog/brand` package in the posthog.com checkout: RoundHog weights under `dist/fonts`, the `Logo` component, colors from `@posthog/brand/colors` (the root export has none), and approved hoggies as PNG under `dist/generated/hoggies/png`. Use a hoggie unmodified and whole, and pick one whose prop does work in the scene, such as a magnifying glass inspecting the input.

## Sound

Allowed providers: ElevenLabs for voice, because work audio and scripts go only to company-sanctioned providers.

## Render: brand pass

Run before calling an explainer or poster done.

- Read the handbook brand pages as Markdown: `https://posthog.com/handbook/brand/{foundations,visual-identity,assets,art-requests}.md`. Report each rule as pass or fix, then apply only the fixes the carbon unit picks.
- Put every number through the handbook's Hacker News test: one baseline across all stats, raw numbers beside each percentage, and a stat from a different test labeled on the board itself, not only in the footer. Picking the friendliest baseline per stat was the first thing the audit caught.
- The headline states a specific result, with its number, about the piece's main point. Vague benefit words such as "smarter" fail the foundations page.
- Use quote marks only on a line someone said.
- Keep the isometric view even though the visual identity page lists isometric 3D under `avoid`: it is the Portal reference, and the graphics team draws isometric scenes too.
- Anything published beyond claude.ai goes to #design-review first, and posting there needs the carbon unit's OK.

## Poster

RoundHog is the font set as paths. Style, from the graphics team's blog art and the carbon unit's rounds:

- Background: faint graph paper with minor and major lines, like the newest blog art. Separate the isometric building from it with the sticker treatment: an ink outline around the room silhouette and a hard offset ink shadow.
- Headline: highlight one word or number with a box in the lighter tint and text in the darker hue.
- It is not a blog card: no series tag, no author line, no hedgehog bleeding off the edge.
- Portal-inspired, with no Portal branding: no portal ovals and no Aperture-style emblem.
- The chamber sign follows the Portal 2 sign: a tall, thin stroked number; `NN/total` over thin ticks, done ones in ink and the rest light, and a chamber number other than the last; a rule; uncaptioned icons right-aligned in uneven rows, only ones that read without a label, with a cake bottom-right; the logo lockup at the bottom. Leave whitespace: a filler stats block and colored tiles were both cut.
- Color lives in the illustration and charts. The sign stays monochrome.
- Stats board: the new arm's accent is green.
