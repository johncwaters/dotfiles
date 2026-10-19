---
name: explainer-animations
description: Make narrated, scripted explainer animations and still posters in a brand's style, such as Portal-2-style isometric "test chamber" instructional videos and launch posters for PostHog docs, as one self-contained SVG page rendered to MP4 (or to PNG for posters) and published as a downloadable Artifact. Covers picking the topic, storyboarding, writing narration in a character voice, directing the camera, checking frames, review by test-audience personas, and rendering. Use for animated docs explainers, docs launch posters, instructional or onboarding animations, product-explainer clips, and "make an animation like <reference> using our brand assets".
---

# Explainer animations

One explainer is one self-contained HTML page: an SVG scene driven by a single clock, with narration subtitles, a step caption and chapter controls. The same page is the interactive Artifact, the downloadable HTML, and the source for the MP4. Keeping it one file means a fix lands everywhere with one rebuild.

## 1. Pick the topic and gather assets

- Choose the topic from the carbon unit's goals or roadmap notes, not from what animates easily. One explainer covers one idea in about four steps.
- Fetch brand assets (fonts, logomark, mascot SVGs) into a scratch `brand/` folder for each run and note their license. Never commit them anywhere: restrictive brand licenses such as PolyForm Strict allow use in the company's own materials, not redistribution.
- Embed the assets as base64 at build time from `template.html` placeholders (`__FONT__`, `__MASCOT__`), so the published page has no external requests.

## 2. Storyboard before code

Write a beat table in story time from 0 to 20 seconds. Each row has the time, what is on screen, the narration line, and the caption step. Every narrated noun must be on screen when it is said. Check every product claim against what the product really prints or does by reading its source or docs; a funny line that misstates the product fails review.

## 3. Narration voice

- Write original lines in the chosen character voice, for example a bombastic founder. Never quote the reference work or name its characters.
- Each line carries one fact and one joke, in at most about 65 characters. The joke must not cost the fact.
- Swap out any line a reviewer says reads oddly or sounds like a threat. Name what is on screen ("Payments, database, CRM") rather than jokes about the narrator.

## 4. Build the page

The scripts below drive the page through this contract, so keep it:

- `#stage` is the SVG element that gets recorded.
- `renderAt(realSeconds)` draws one frame. `realTimeAt(storySeconds)` maps story time to real time, and `window.totalSeconds` is the loop length.
- Opening the page with the hash `#t<storySeconds>` shows a paused still at that story time.

Time-stretch: author everything in story time, then slow each subtitle window to `max(span, characters / 15 + 0.6)` real seconds, and hold the end card at least 5 s. Gaps between windows run at 1x. Viewers read slower than you write; the first versions were unreadable.

Isometric drawing: draw back to front by depth. A part that sits under another (a flange under a pipe) is drawn first, or it paints over the part above it.

Direct the eye with a camera shot list keyed to the narration windows: `{ at, centerX, centerY, zoom }`, eased between shots. Frame whatever the current line talks about. Make pop-ups appear where the camera already is, for example a browser window opening on the terminal screen rather than in a far corner.

Motion follows Disney's twelve principles. Before animating, read [references/animation-principles.md](references/animation-principles.md), which maps each one to a time-based state term and covers seamless loops.

Page chrome: chapter buttons have fixed labels (`<ui_button_labels>`), there is a dark-mode token set, and prefers-reduced-motion gets a still frame.

## 5. Check frames

```
node <skill-dir>/scripts/frames.mjs sheet --page <page.html> --times 1,2.6,4.7,6.6,9.5,11.3,13.3,16.8 --columns 4 --out sheet.png
```

Read every sheet. Pick times inside each beat and at each transition. Check for:

- labels covering logos or the subject;
- subtitles caught mid-fade (lines that run straight into each other need near-instant swaps);
- elements clipped by the camera or by other scenery;
- sprites that read as dust at small sizes;
- a final push-in that frames empty scenery.

## 6. Test audience

Spawn four persona reviewers in parallel: the target developer, a fan of the reference genre, a brand designer, and a docs lead who owns accuracy. Use Agent with `model: "opus"` and the standard `Scope:`, `Out of scope:` and `Definition of done:` lines. Each one reads the brief built from [templates/review-brief.md](templates/review-brief.md) plus the sheet paths, scores the explainer, and returns blocking and optional notes with frame times. Resume the same agents with SendMessage for later rounds so they judge what changed. Apply the blocking notes, keep accuracy over a joke, record the notes you rejected along with the reason, and repeat until no reviewer has a blocker.

## 7. Render and publish

```
node <skill-dir>/scripts/frames.mjs render --page <page.html> --out <name>.mp4
```

Run it with `run_in_background`, because a 50 s loop at 30 fps takes minutes. Make only MP4 unless a GIF is asked for. Publish the page as an Artifact with `capabilities: {"downloads": true}`, with `downloads/<name>.mp4` and `downloads/<name>.html` (the standalone page with a doctype). Republish to the same URL for later rounds. Tell the carbon unit the link is private until they share it.

## 8. PostHog brand pass

Run before calling an explainer or poster done.

- Read the handbook brand pages as Markdown: `https://posthog.com/handbook/brand/{foundations,visual-identity,assets,art-requests}.md`. Report each rule as pass or fix, then apply only the fixes the carbon unit picks.
- Take assets from the `@posthog/brand` package in the posthog.com checkout: RoundHog weights under `dist/fonts`, the `Logo` component, colors from `@posthog/brand/colors` (the root export has none), and approved hoggies as PNG under `dist/generated/hoggies/png`. Use a hoggie unmodified and whole, and pick one whose prop does work in the scene, such as a magnifying glass inspecting the input.
- Put every number through the handbook's Hacker News test: one baseline across all stats, raw numbers beside each percentage, and a stat from a different test labeled on the board itself, not only in the footer. Picking the friendliest baseline per stat was the first thing the audit caught.
- The headline states a specific result, with its number, about the piece's main point. Vague benefit words such as "smarter" fail the foundations page.
- Use quote marks only on a line someone said.
- Keep the isometric view even though the visual identity page lists isometric 3D under avoid: it is the Portal reference, and the graphics team draws isometric scenes too.
- Anything published beyond claude.ai goes to #design-review first, and posting there needs the carbon unit's OK.

## 9. Still posters

A poster is one frame of the same chamber. A node generator writes the SVG and sharp renders it to PNG at density 144. RoundHog text goes in as paths through `@foliojs-fork/fontkit`, because librsvg does not load web fonts. Copy the generator to `poster.vN.js` before each round so any step can roll back, crop the changed region to check it, and republish to the same Artifact URL.

Style, from the graphics team's blog art and the carbon unit's rounds:

- Background: faint graph paper with minor and major lines, like the newest blog art. Separate the isometric building from it with the sticker treatment: an ink outline around the room silhouette and a hard offset ink shadow.
- Headline: highlight one word or number with a box in the lighter tint and text in the darker hue.
- It is not a blog card: no series tag, no author line, no hedgehog bleeding off the edge.
- Portal-inspired, never Portal-branded: no portal ovals and no Aperture-style emblem.
- The chamber sign follows the Portal 2 sign: a tall, thin stroked number; `NN/total` over thin ticks, done ones in ink and the rest light, and never the last chamber; a rule; uncaptioned icons right-aligned in uneven rows, only ones that read without a label, with a cake bottom-right; the logo lockup at the bottom. Leave whitespace: a filler stats block and colored tiles were both cut.
- Don't label a hatch with a direction. "Docs in" over a hatch that cubes come out of reads backwards; the stripes alone make it read as a dispenser.
- Color lives in the illustration and charts. The sign stays monochrome.
- Stats board: phrase every stat as a reduction so a shorter bar is always better, draw the new arm in solid green and the baseline in the same green at 50% opacity (PostHog's own compare-to-previous convention, `getTrendLikeSeriesColor` in the posthog repo's `frontend/src/lib/colors.ts`), keep the raw-number caption neutral gray, and say solid and faded in the legend. Red read as "bad" on an arm that is only the old version.
- Alt text carries the headline and every number on the poster.
