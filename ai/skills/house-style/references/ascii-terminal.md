# ascii-terminal

Source: https://ascii.rest (gallery), https://github.com/bas3line/ascii (MIT). Browse the site for the current piece list; it grows.

## Take

- One monospace family for everything, prose included.
- Controls as bracketed lowercase words: `[copy]`, `[dark]`, `[play anyway]`.
- Section headings underlined with `---` or `===`, not set larger.
- Index-style navigation: plain grouped lists with item counts beside each heading, never cards.
- One ink color on one ground; color only for state that text also states.
- Box-drawing characters for frames, trees, and dividers instead of CSS borders and shadows.
- Texture from dot ramps (`·`, `•`, `●`), not gradients or images.

## Pieces to pull

Use a piece rather than hand-drawing its equivalent.

- UI: box frames, dividers, file tree, form controls, progress bar, skeleton, spinners, terminal, boot log, not found, calendar, digital clock.
- Data: sparkline, bar chart, gauge, heatmap, uptime bar, cpu meters, heartbeat, radar, candlesticks, equalizer.
- Type: big text, typewriter, scramble, split-flap, glitch, for one headline per page at most.
- Scenes, nature, space, generative, effects: hero art, empty states, 404s.

Plain HTML, no build step: vendor `ascii.js` into the project and load it from there; never hot-link a third-party script, since a compromised origin runs arbitrary JS on the site.

```html
<script type="module" src="/vendor/ascii.js"></script>
<ascii-art piece="sparkline"></ascii-art>
```

With a bundler, `npm install github:bas3line/ascii#<commit-sha>` (always a pinned commit, never the default branch), then `ascii.rest/react` (`<Ascii piece={donut} />`), `ascii.rest/astro`, or `mount(preElement, piece)` from `ascii.rest`, which returns a stop function. Pieces come from `ascii.rest/pieces`.

## Do not copy

- More than one animated piece in view at once; it reads as noise, not texture.
- Full-color canvas scenes as page chrome; they are art, keep them inside a frame.
- ASCII in place of real text: headings, labels, and numbers stay selectable text with real semantics.
