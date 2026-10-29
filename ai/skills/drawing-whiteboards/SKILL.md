---
name: drawing-whiteboards
description: Draws architecture and flow whiteboards as hand-placed column diagrams from a small board file, with arrows routed and checked so none run through boxes or over text, then publishes the page as an artifact. Use for "whiteboard this", "draw the architecture", "diagram how X flows", or a design doc that needs a system map.
---

# Whiteboards

Place every box by hand in left-to-right columns; the renderer only routes arrows and checks the result. Keep layout in your hands: an auto-layout render (D2 with ELK) of the same board read far worse.

1. Write a board file in a scratch directory, modeled on `examples/webhook-to-email.ts`: a default-exported function that takes the helpers and returns a `Board` (types in `render.ts`). Keep its only import an `import type`, so the file renders from anywhere.
2. Write box text in plain words, not code names. The title says what happens ("check we may email them"); each line gives an outcome ("unsubscribed → stop here"). Start a line with `~` to render it as a small grey note. Keep a box to a few lines: one box per step a reader would say aloud, not one per function.
3. Merge arrows that enter one box into a bus, so the box gets one arrowhead. Mark designed-but-unbuilt parts as `ghost` boxes and outside systems as `ext`. Pick lane colors as light as the example's: the board is semi-dark, so saturated light-theme colors sink into it.
4. Run `node ~/.claude/skills/drawing-whiteboards/render.ts <board.ts> <out dir>/index.html --screenshot <out dir>/board.png`. Fix every problem by moving boxes, channels, or anchors, and rerun until it prints `ok`. Clear the `crossing:` warnings too by reordering channels where you can.
5. Read `board.png` and fix anything the checks cannot see: a label far from its arrow, or a column that reads out of order.
6. Publish `index.html` with the `claude-artifacts` `publish_files` tool. When the carbon unit already has an artifact for this board, republish to that one.

## Scripts

- `render.ts`: Routes the arrows, checks the layout, writes the page, and with `--screenshot` captures it in headless Chrome; exits 1 and names each problem when the board is broken.
