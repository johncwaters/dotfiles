---
name: designing-ui
description: Guides the design process for any UI, personal or work. Use when building, styling, or reviewing a screen, a user flow, an error or empty state, a limit or quota message, or motion and animation in a UI, or when asked to make a product feel premium, less generic, or past the AI look. Owns behavior and process; the look comes from the project's taste, which the taste step resolves.
---

# Design

Polished screens are the floor every competitor reaches with the same tools. What reads as premium is evidence of care in the states nobody screenshots, rendered in the project's own taste.

Open each step's file with the Read tool before acting on that step; the one-line summaries below leave out what each step requires.

1. [triage](subskills/triage.md): on an existing screen, decide how much to change before changing anything.
2. [taste](subskills/taste.md): resolve the look before writing any UI.
3. [theme-scene](subskills/theme-scene.md): the physical scene that picks dark or light, and where the richness goes.
4. [answer-back](subskills/answer-back.md): every action says what happened, how to take it back, what comes next.
5. [one-product](subskills/one-product.md): the same situation looks and reads the same everywhere.
6. [break-it](subskills/break-it.md): failure, empty, and offline states designed as carefully as success.
7. [motion](subskills/motion.md): how anything moves.

Building runs steps 2 to 7 and the finish on the flow in scope. On an existing screen, step 1 runs first and its level sets the scope: heavy runs all of it, light fixes only the found tells, none stops at the offered refinements. Reviewing runs step 1, then steps 4 to 7 and finish step 2's layout-shift run on the rendered UI, and reports each gap, every shift included, as one row:

```
screen | state | fix
```

Finish when each step has walked the whole flow in scope and every gap has a fix or a named reason to leave it, then:

1. Run `node ~/.claude/skills/designing-ui/scripts/lint-slop.mjs <ui-files-or-dir>` and rerun until it exits 0, keeping a flag only where the resolved taste names that rule.
2. Serve the flow and run `node ~/.claude/skills/designing-ui/scripts/layout-shift.mjs --url <flow-url> [--steps steps.json]`, with steps as `[{"click": "<selector>"}, {"fill": "<selector>", "value": "..."}, {"scroll": "<selector>"}, {"waitMs": 1500}, {"offline": true}, {"failRequests": "<url glob>", "status": 503}]` walking every state in scope. `offline` and `failRequests` (a `status` such as 401, 403, 429, or 503, or none for a network error) force step 6's failures and last for the rest of the walk; end the walk in a failure state, since the review stamp refuses a report that forced none unless `--no-failure-states <reason>` names why. Rerun until it exits 0: zero shifts, click-driven ones included, so reserve space for late content and keep controls a fixed size.
3. Template check: swap in a competitor's product name. A screen that still fits gets pushed further in its copy, its moments, and its signature detail.

## Scripts

- `scripts/lint-slop.mjs`: flags taste-neutral AI-template tells (transition-all, hover scale, looping pulse or bounce, gradient text, 800+ weights, emoji, colored glows, off-grid arbitrary px, icon nudges: an icon shifted by a px `margin-top`, `top`, or `translateY`, fixed by `align-items: start` on the row and `margin-block: calc((1lh - <icon size>) / 2)` on the icon) as `file:line: rule`, exit 1 while any remain.
- `scripts/layout-shift.mjs`: loads a URL in Chromium at 640 and 1440 wide in light and dark, scrolls the whole page after load and after the last step, since only on-screen shifts are reported, walks the optional steps, and prints every layout shift as `width mode | when | score | frame url | element rects`, exit 1 while any remain. `--report <file>` outside the checkout also writes a screenshot per width and mode beside it, named after it, and the JSON report the review stamp's `--ui-evidence` takes. Chromium only: Firefox and Safari lack the Layout Instability API.
