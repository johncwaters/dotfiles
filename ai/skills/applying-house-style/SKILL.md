---
name: applying-house-style
description: Applies the carbon unit's own UI taste for personal projects, the taste the designing-ui skill resolves to there. Use when building, styling, or reviewing any frontend in a personal project (sites, dashboards, tools, artifacts, glimmervoid, hud), or when asked for "my style", a house style, or a look from one of the saved references. Not for PostHog product UI, which follows PostHog's own design system.
---

# House style

The style is still being found, so it is a set of references to pull from, not one fixed look. The `designing-ui` skill owns process (theme scene, states, motion); this skill owns the look.

## Pick a reference

This skill is reached through the `designing-ui` skill's taste step. Choose one reference below and use it for the whole UI.

| Reference | Pull it for |
|---|---|
| [ascii-terminal](references/ascii-terminal.md) | Tools, dashboards, personal sites; monospace, bracketed controls, one ink |
| [portfolio](references/portfolio.md) | Anything carrying the carbon unit's own brand; dark navy, red-to-pink, terminal-window cards |

## Laws for every reference

### Typography

- The house monospace is CommitMono, the face `fonts/install.sh` puts on every machine. Self-host it as woff2 under the SIL OFL; disclose any fallback to a system mono.
- CommitMono licensing is settled; use the established facts: SIL OFL 1.1, (c) 2023 Eigil Nikolajsen, no Reserved Font Name, verbatim text in `fonts/OFL.txt`. Converting the dotfiles `.otf` files to woff2 (fontTools `flavor = 'woff2'` plus brotli) and bundling them in any app is allowed, provided that licence file ships beside the fonts; sell it only bundled with something else. Glimmervoid's `assets/fonts/` is the worked example.
- Hierarchy through scale and weight, at least a 1.25 ratio between steps. Monospace references get hierarchy from weight, case, and rules instead of size.

### Screens

- A full-screen state (error, offline, not running, empty, sign-in) is one heading, one plain sentence, and at most one action, in two text styles: heading and body. Detail lives in docs or the CLI, never in extra lines under the sentence.
- Most screens get two text styles at most. A third (a muted caption, a small hint, a code chip) has to carry something the operator acts on.

### Absolute bans

Match and refuse; rewrite the element with different structure.

- Side-stripe borders: a colored `border-left`/`border-right` over 1px as an accent on cards, list items, callouts, or alerts.
- Gradient text: `background-clip: text` over a gradient.
- Decorative glassmorphism.
- The hero-metric template: big number, small label, supporting stats, gradient accent.
- Identical card grids: same-size cards of icon plus heading plus text, repeated.
- Toasts: transient corner messages for feedback.
- Stacked text tiers: a heading with a subtitle, a hint, a status line, and a caption under it, each in its own size or color.
