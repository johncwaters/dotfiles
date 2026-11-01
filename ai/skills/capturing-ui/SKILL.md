---
name: capturing-ui
description: Captures real UI as evidence: before/after screenshot grids in light and dark, hover-and-click GIFs, and frame-exact MP4 clips of real components on made-up data, with a preview sheet and a downloadable share page. Use when a PR needs screenshots or a recording, a post needs a UI clip, motion needs review on the real app, or asked to "screenshot this", "record a clip", or "show it working".
---

# Capturing UI

Capture only real UI: the product's own code, on its own dev server or in a harness that loads its real components. Dependencies live in this skill directory and are installed by `ai/install.sh`.

## Extensions

Each installed skill whose name starts with `capturing-ui-` extends this one with a machine's conventions. Load every one listed among your available skills before capturing, then apply each section it adds at the section of this skill it names. Extensions win over this skill's defaults, and the repo's own screenshot or reviewer guide wins over extensions.

## Screenshots

1. **Own dev server port.** Check `lsof -iTCP:<port> -sTCP:LISTEN` first. Another worktree's server on the same port answers `localhost` and silently serves the old code, so a before/after grid shows no change.
2. **Before state from mainline, not memory.** Set uncommitted work aside in a WIP commit: on a dirty tree, first `git add -A` and `git commit -m "WIP set-aside"`, matching `/landing`. Sort the files with `git diff --no-renames --name-status origin/<mainline>...HEAD -- <files>`: `A` is added, `D` is deleted, the rest modified. Then `git restore --source=origin/<mainline> --worktree -- <modified> <deleted>` and delete the added files, capture, `git restore --source=HEAD --worktree -- <modified> <added>` and delete the deleted files again, then `git reset --soft HEAD~1` if you created the WIP set-aside commit. `--worktree` leaves the index untouched, and no per-file backup means two `index.tsx` cannot clobber each other. Wait ~30s for hot reload between states.
3. **Capture with `scripts/evidence.mjs`.** Run it in place as `node <skill-dir>/scripts/evidence.mjs <command> ...`; converge installs its locked dependencies. It drives the installed Google Chrome, so nothing downloads a browser and no `ffmpeg` is needed. On a Linux devbox without Chrome it falls back to Playwright's `chrome-headless-shell` (`npx playwright-core install --only-shell chromium` once) and links the system libraries it lacks into `~/.cache/evidence-chrome-libs`, because the Nix host has no `apt`.
   - `grid --url --selector --state before|after --area <slug> --out <dir>`: light and dark at 640px and 1440px, fresh context per shot, named `<state>-<area>-<mode>-<width>.png` so the later commands can pair them.
   - `gif --url --selector --target --out <file>.gif`: hover then click on `--target`, for anything that zooms, animates, or reacts. Writes three frame PNGs beside it; read them, since a GIF cannot be checked by opening the file.
   - `--local-storage '<json>'` (`{mode}` is substituted per shot) and `--dismiss '<selector>'` set the theme and clear banners; an extension's reference names the values for its sites.
4. **Console, both sides.** `grid` prints the console errors it saw; the PR claims "no new errors" only when the before and after sets match.
5. **Exercise beyond looking.** Click the control and read the clipboard, check the toast, check links. A still proves layout, not behavior. Wait for hydration before clicking; a click on static HTML does nothing and reads as a bug.
6. **Preview.** `sheet --dir <dir>` writes `preview.html`, with the GIF and frames under Other files; `open` it and read every image before any leaves the machine.

## Clips

A clip shows what a still cannot: an animation, a transition, a state change. A demo video of the whole running app is the `recording-demo-videos` skill's job instead. A clip runs the project's real component code and stylesheet on made-up data, excluding mocks and live sessions, because a mock shows something the product does not do and a live session shows the carbon unit's private work.

1. Build a harness directory. Its `index.html` loads the project's real stylesheet and fonts plus one script, bundled with the project's own bundler from an entry file that imports the real component module and exposes a global function per behavior (`window.playScene = (sceneIndex, message) => celebrateMerge(message, scenes[sceneIndex])`). Framing copy and position overrides go only in the harness page, keeping project code unchanged. The recorder serves the directory over loopback, because real stylesheets use root-absolute font and asset URLs that `file://` cannot resolve.
2. Write `marketing/social/clip.json` and run `node <skill-dir>/scripts/record-clip.mjs --manifest marketing/social/clip.json`. Each scene's `run` is evaluated in the page at that scene's first frame.

```json
{
  "harness": "harness/merge-celebrations",
  "placement": "instagram-square",
  "cssWidth": 480,
  "out": "out/final/merge-celebrations.mp4",
  "scenes": [{ "run": "playScene(0, 'Merged Acme/app#1322')", "durationMs": 4800 }]
}
```

   `cssWidth` is the viewport the component lays out in and the placement's pixels come from device scale, so small UI fills the frame sharp instead of as an upscaled bitmap. The recorder freezes the page clock and steps every animation one frame at a time, so the clip is exact at any frame rate and a timer in the component fires at its real moment; a realtime screen capture drops frames and outlives those timers. The recorder keeps every running animation paused in order to seek it, so it cannot see the page pause one that an earlier frame already showed running: `pause()` or `animation-play-state: paused` on it is ignored and it plays on. Output is H.264 MP4, the format [Buffer lists](https://support.buffer.com/article/616-uploading-and-sharing-links-to-videos) for X and LinkedIn, where WebM is absent.
3. Read every `<out>.scene-<n>.png` the recorder writes beside the clip, one mid-scene frame each, and rerecord when a scene does not show what the caption says.
4. Hand it over with `node <skill-dir>/scripts/share-page.mjs --clip <clip.mp4> --captions captions.json --title "<short name>" --out <page.html>`, where captions.json is `[{ "label": "LinkedIn post", "text": "..." }]` with one entry per caption and the alt text. Publish that file as an Artifact with `capabilities: {"downloads": true}` and give the carbon unit the link, because a local path cannot be opened from a phone and the Artifact viewer blocks plain download links; the page embeds the clip, saves it through the downloads capability, and puts each caption in its own copy block.

## Scripts

- `scripts/evidence.mjs`: Captures before/after grids, GIFs, preview sheets, and the embed table; run for screenshots.
- `scripts/record-clip.mjs`: Records real-component harness scenes; run after writing clip.json.
- `scripts/share-page.mjs`: Embeds a clip and captions in a downloadable page; run before publishing the handoff Artifact.
