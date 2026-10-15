---
name: explainer-animations
description: Make narrated, scripted explainer animations in a brand's style, such as Portal-2-style isometric "test chamber" instructional videos for PostHog docs, as one self-contained SVG page rendered to MP4 and published as a downloadable Artifact. Covers picking the topic, storyboarding, writing narration in a character voice, directing the camera, checking frames, review by test-audience personas, and rendering. Use for animated docs explainers, instructional or onboarding animations, product-explainer clips, and "make an animation like <reference> using our brand assets".
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
