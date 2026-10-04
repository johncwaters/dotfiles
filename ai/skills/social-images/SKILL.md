---
name: social-images
description: Compose social media images from real repo assets and HTML/CSS, with no AI image generation. Use for Instagram posts, stories or carousels, OG images or link cards, X/LinkedIn/Bluesky/Pinterest graphics, launch graphics, and marketing images from screenshots.
---

Use real assets from the target project; never stock imagery or generated art. Dependencies live in this skill directory and are installed by `ai/install.sh`.

1. Inventory brand tokens in DESIGN.md/DESIGN.json, Tailwind config, CSS custom properties, and theme files; logo SVG/PNG; bundled font files; and app screenshots from the project's deterministic capture path (widget/visual tests or Playwright against its dev server). Copy OFL or otherwise licensed font files with their license. Write `marketing/social/brand.json` using [templates/brand.example.json](templates/brand.example.json); all asset paths are relative to the manifest. If no brand exists, use `{}` for neutral defaults and tell the carbon unit.
2. Copy [hook.html](templates/hook.html) and [screenshot.html](templates/screenshot.html) into the target project's `marketing/social/templates/`. Write `marketing/social/manifest.json` in this shape; `deviceFrame: true` optionally enables the screenshot's CSS frame:

```json
{
  "brand": "brand.json",
  "shots": [{
    "template": "templates/hook.html",
    "placement": "instagram-portrait",
    "out": "out/launch-1.png",
    "alt": "Describe the image for publication.",
    "vars": { "eyebrow": "Launch", "headline": "One short hook", "subline": "One supporting line", "image": "assets/art.png" }
  }]
}
```

3. Run `node <skill-dir>/scripts/render.mjs --manifest marketing/social/manifest.json --safe-zones --sheet`. Open the output `preview.html` for the carbon unit and iterate. Keep review outputs apart from final outputs by changing manifest `out` paths.
4. Render without `--safe-zones` for publication. Use the renderer's `alt.json` when publishing; this workflow creates files and does not authorize publishing.

`scripts/render.mjs` owns the placement table and enforces manifest/brand validity, asset loading, minimum text size, PNG dimensions, and byte limits.

- One hook goes on the image; the sentence goes in the post caption.
- Carousels share a canvas, margins, and type ramp; slide 1 is the hook.
- Keep screenshots frameless unless the shot is an inset.
- Show real UI only; invented controls misrepresent the product.
