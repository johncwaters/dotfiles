---
name: house-style
description: The carbon unit's own UI taste for personal projects. Use when building, styling, or reviewing any frontend in a personal project (sites, dashboards, tools, artifacts, glimmervoid, hud), or when asked for "my style", a house style, or a look from one of the saved references. Not for PostHog product UI, which follows PostHog's own design system.
---

The style is still being found, so it is a set of references to pull from, not one fixed look.

## Pick a reference

1. If the project has a `DESIGN.md`, it wins; follow it and stop picking.
2. Otherwise choose one reference below for the whole UI and name it to the carbon unit in one line before writing code. Never blend two references in one screen.
3. Once the carbon unit settles on a look for a project, record the reference name in that project's `DESIGN.md` so later sessions do not re-pick.

| Reference | Pull it for |
|---|---|
| [ascii-terminal](references/ascii-terminal.md) | Tools, dashboards, personal sites; monospace, bracketed controls, one ink |
| [portfolio](references/portfolio.md) | Anything carrying the carbon unit's own brand; dark navy, red-to-pink, terminal-window cards |

## Laws for every reference

### Theme

Dark vs. light is never a default. Write one sentence of physical scene first: who uses this, where, in what light, in what mood. "Dashboard" forces nothing; "me checking a deploy on a laptop in a dim room at midnight" does. If someone could guess the palette from the category name alone, rework the scene.

### Typography

- The house monospace is CommitMono, the face `fonts/install.sh` puts on every machine. Self-host it as woff2 under the SIL OFL; never fall back to a system mono without saying so.
- CommitMono licensing is settled, do not re-research it: SIL OFL 1.1, (c) 2023 Eigil Nikolajsen, no Reserved Font Name, verbatim text in `fonts/OFL.txt`. Converting the dotfiles `.otf` files to woff2 (fontTools `flavor = 'woff2'` plus brotli) and bundling them in any app is allowed, provided that licence file ships beside the fonts; never sell the font on its own. Glimmervoid's `assets/fonts/` is the worked example.
- Body line length 65–75ch.
- Hierarchy through scale and weight, at least a 1.25 ratio between steps. Monospace references get hierarchy from weight, case, and rules instead of size.

### Motion

- Never animate layout properties; transform and opacity only.
- Ease out with exponential curves. No bounce, no elastic.
- Pause anything looping while it is off screen, and hold its first frame under `prefers-reduced-motion`.

### Absolute bans

Match and refuse; rewrite the element with different structure.

- Side-stripe borders: a colored `border-left`/`border-right` over 1px as an accent on cards, list items, callouts, or alerts.
- Gradient text: `background-clip: text` over a gradient.
- Decorative glassmorphism.
- The hero-metric template: big number, small label, supporting stats, gradient accent.
- Identical card grids: same-size cards of icon plus heading plus text, repeated.
- A modal as the first idea, before inline or progressive options.
