---
name: designing-ui
description: Guides the design process for any UI, personal or work. Use when building, styling, or reviewing a screen, a user flow, an error or empty state, a limit or quota message, or motion and animation in a UI, or when asked to make a product feel premium, less generic, or past the AI look. Owns behavior and process; the look comes from the project's taste, which the taste step resolves.
---

# Design

Polished screens are the floor every competitor reaches with the same tools. What reads as premium is evidence of care in the states nobody screenshots, rendered in the project's own taste.

Read each file under `subskills/` as you reach it:

1. [taste](subskills/taste.md): resolve the look before writing any UI.
2. [theme-scene](subskills/theme-scene.md): the physical scene that picks dark or light.
3. [answer-back](subskills/answer-back.md): every action says what happened, how to take it back, what comes next.
4. [one-product](subskills/one-product.md): the same situation looks and reads the same everywhere.
5. [break-it](subskills/break-it.md): failure, empty, and offline states designed as carefully as success.
6. [motion](subskills/motion.md): how anything moves.

Building runs every step on the flow in scope. Reviewing runs steps 3 to 6 on the rendered UI and reports each gap as one row:

```
screen | state | fix
```

Finish when each step has walked the whole flow in scope and every gap has a fix or a named reason to leave it, then:

1. Run `node ~/.claude/skills/designing-ui/scripts/lint-slop.mjs <ui-files-or-dir>` and rerun until it exits 0, keeping a flag only where the resolved taste names that rule.
2. Template check: swap in a competitor's product name. A screen that still fits gets pushed further in its copy, its moments, and its signature detail.

## Scripts

- `scripts/lint-slop.mjs`: flags taste-neutral AI-template tells (transition-all, hover scale, looping pulse, gradient text, 800+ weights, emoji, colored glows, off-grid arbitrary px) as `file:line: rule`, exit 1 while any remain.
