---
name: drawing-whiteboards
description: Draws architecture and flow whiteboards as hand-placed column diagrams from a small board file, with arrows routed and checked so none run through boxes or over text. Use for "whiteboard this", "draw the architecture", "diagram how X flows", or a design doc that needs a system map.
---

# Whiteboards

1. Write a board file modeled on `examples/webhook-to-email.ts`.
2. Run `node ~/.claude/skills/drawing-whiteboards/render.ts <board.ts> <out dir>/index.html`. Fix every problem it prints and rerun until it prints `ok`.

## Scripts

- `render.ts`: Routes the arrows, checks the layout, and writes the page; exits 1 and names each problem when the board is broken.
