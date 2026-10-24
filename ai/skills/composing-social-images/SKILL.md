---
name: composing-social-images
description: Composes social media images and short UI clips from real repo assets and HTML/CSS, with no AI image or video generation. Use for Instagram posts, stories or carousels, OG images or link cards, X/LinkedIn/Bluesky/Pinterest graphics, launch graphics, GitHub previews, YouTube thumbnails, and a video or clip that shows off an animation, transition or other UI behavior.
---

# Social images

Use only real project assets, excluding stock imagery and generated art. Dependencies live in this skill directory and are installed by `ai/install.sh`.

1. Inventory DESIGN.md/DESIGN.json frontmatter, theme tokens, logos and licensed font files. Map canvas/background to `background`, card/inset to `surface`, heading text to `ink`, primary to `accent`, and text on primary to `accentInk` in `marketing/social/brand.json` ([shape](templates/brand.example.json)). Dark brands stay dark. If no brand exists, resolve taste through the `designing-ui` taste step and map it to these roles; use neutral defaults only when no taste resolves, and tell the carbon unit which.
2. A system font stack is not a font asset. Fetch the OFL webfont from `@fontsource/<family>` on npm or the foundry's release into `marketing/social/fonts/`; keep its license beside it and point brand.json at the files and their actual weights. Code blocks use an optional `mono` role, so give code-heavy brands a monospace font file there. Keep branded renders on their supplied font assets, with machine-font fallback excluded.
3. Prefer the project's own deterministic screenshot tooling: an isolated instance plus replayed or fixture data. If unavailable, extract representative frames from committed demo media. Record the path used. Capture only real UI.
   Capture at 2x or crop less; scale images only downward; render.mjs caps image enlargement at 1.25x output pixels.
4. Copy the selected templates into `marketing/social/templates/`, keeping each `<html data-template="...">` kind even when renaming; validation rules follow that kind, not the file name. Asset and code paths are relative to the manifest and must remain inside the git top-level. Use README/PRODUCT/CHANGELOG wording for claims; use only evidenced numbers, testimonials and carbon unit counts. Stat figures require a cited repo fact in `source`. Release version, date and highlights come from CHANGELOG or release notes.
5. Write `marketing/social/manifest.json`. One hook belongs on an image; longer copy belongs in the post caption. Use `carousel.html` throughout a set for structural continuity; slide 1 is the hook. It accepts `items` and `code`/`command`. When a CTA must use `code.html`, keep its matching carousel frame and the same placement, slide pair, margins and type ramp.

```json
{
  "brand": "brand.json",
  "shots": [{
    "template": "templates/carousel.html",
    "placement": "instagram-portrait",
    "out": "out/review/launch-1.png",
    "alt": "Describe the image for publication.",
    "source": "README.md, opening tagline",
    "vars": { "slideNumber": 1, "slideCount": 5, "eyebrow": "Launch", "headline": "One short hook", "subline": "One supporting line" }
  }]
}
```

Template picker:
- [hook.html](templates/hook.html): a single hook with eyebrow, headline, subline and optional image.
- [carousel.html](templates/carousel.html): a continuous slide set; `slideNumber`/`slideCount` (1-20), eyebrow, headline, subline, optional image, items or code; swipe cue only on slide 1.
- [screenshot.html](templates/screenshot.html): real UI with headline and supporting copy; `deviceFrame: true` only for an inset.
- [stat.html](templates/stat.html): a cited repo figure (`figure`, `label`, `context`); `source` is mandatory.
- [features.html](templates/features.html): headline and `items`, 2-4 short strings.
- [code.html](templates/code.html): real code/terminal excerpt or quickstart command, with headline and supporting copy.
- [release.html](templates/release.html): `version`, `date`, and `highlights` from release notes; prefer `{ "title": "Short title", "detail": "One-line detail" }` objects, with plain strings also accepted.

Placement picker:
- `instagram-portrait` 1080x1350 / `instagram-square` 1080x1080: feed posts and carousel sets.
- `story` 1080x1920: 9:16 stories with interface overlays reserved.
- `link-card` 1200x630 / `x-card` 1200x600: link unfurls; link-card keeps text within the centered square crop.
- `landscape` 1600x900: X, Bluesky, Threads and LinkedIn in-feed single images.
- `github-social-preview` 1280x640: repository previews; generous margins protect GitHub and chat crops.
- `youtube-thumbnail` 1280x720: video thumbnails; the bottom duration-badge band is unsafe.
- `pinterest` 1000x1500: tall pins.

List vars other than highlights are arrays of 1-6 nonempty strings rendered as escaped list items into `data-slot-list`. Code uses `"code": { "file": "../../src/example.ts", "startLine": 1, "endLine": 8 }` (inclusive, at most 12 lines) or a nonempty `command`, exclusively. Commands use explicit newlines with trailing shell backslashes for continuations; tokens stay unwrapped. The renderer fits the longest line down to the placement minimum, then rejects overflow. Both slots have a 12-line cap and excerpts come only from git-tracked files inside the repo. Shorten copy instead of shrinking below the placement minimum.

Run `node <skill-dir>/scripts/render.mjs --manifest marketing/social/manifest.json --safe-zones --sheet`. Inspect every PNG and `out/review/preview.html`; fix overlap, clipping, low contrast and unused space. Change shot outputs to `out/final/`, then render with `--sheet` without safe zones. Both runs must exit 0. The renderer enforces shapes, assets/fonts, text size and safe insets, PNG dimensions and the 1,000,000-byte ceiling; inspect screenshot readability visually. `alt.json` and sibling `sources.json` merge by filename. These files support publication; rendering does not authorize publishing.

## Clips

A clip shows what a still cannot: an animation, a transition, a state change. Load `capturing-ui` to record it; its motion craft (timing, easing, staging) follows the `animating` skill (`~/.claude/skills/animating`).

## Scripts

- `scripts/render.mjs`: Validates and renders image manifests; run for safe-zone review and final output.
