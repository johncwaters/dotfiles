# Triage

An existing screen gets a verdict on how much to change before any edit, because restyling a good screen just to make it different throws away decisions someone already made.

Run `node ~/.claude/skills/designing-ui/scripts/lint-slop.mjs` on the screen's files, look at the rendered screen, then pick one level:

- **Heavy**: tells across color, type, icons, and copy. Run every step and rework the look within the resolved taste.
- **Light**: mostly designed, a few tells left. Fix only what the linter and the look found, keep the existing palette, type, layout, and brand, and list bigger ideas as suggestions.
- **None**: say so, offer two or three refinements with exact values, and apply them only once the carbon unit agrees.

Name the level and its evidence to the carbon unit in one line before editing.
