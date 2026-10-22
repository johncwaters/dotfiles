# Render

```
node <skill-dir>/scripts/frames.mjs render --page <page.html> --out <name>.mp4
node <skill-dir>/scripts/frames.mjs render --page <page.html> --audio mix.wav --max-mb 15 --out <name>.mp4
```

The second form is for a narrated piece: `--max-mb 15` two-pass encodes under the Artifact's 16 MB per-file cap, which a 21 MB MP4 once broke. Run either with `run_in_background`, because a 50 s loop at 30 fps takes minutes, and check for 1 GB of free disk for its frames. Make only MP4 unless a GIF is asked for.

Publish the page as an Artifact with `capabilities: {"downloads": true}`, with `downloads/<name>.mp4` and `downloads/<name>.html` (the standalone page with a doctype). Republish to the same URL for later rounds. Tell the carbon unit the link is private until they share it.
