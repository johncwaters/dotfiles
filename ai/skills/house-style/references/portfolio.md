# portfolio

Source: the carbon unit's own site, https://www.johncwaters.com, repo `~/Projects/portfolio` (Astro, Tailwind 4, daisyUI 5). Read `src/styles/global.css` and `src/components/smallparts/ProfessionalWork.astro` for the live values; this file records intent, not a token copy.

## Take

- Dark ground in deep navy (`#002438` base, `#001b2b` terminal panels, `#032033` window chrome, `#12455e` hairlines), white ink.
- Red-to-pink brand pair (`#ff0005` to `#ff0092`), with `#ff5c8a` as the readable soft pink for links, prompts, and hover text. Pure accent red fails contrast on the navy; text gets the soft tint.
- Monospace for chrome and headings, sans for long-form prose so blog posts stay readable.
- Terminal-window frames as the card idiom: a title bar with a `>_` glyph and a `user@host: ~/path` caption, `$ cat file` above the title, `# ` before the impact line, a `$ ` prompt before the link.
- A block cursor that blinks only on hover, `steps(1)`, and stops under reduced motion.
- Stack lists as uppercase tracked small caps joined by ` / `.
- Hairline 1px borders that warm to soft pink on hover; no shadows.

## Do not copy

- The 3px red-to-pink stripe on `.workCard::before`: it is a side-stripe accent, banned by the laws.
- Gradient-filled buttons; one solid fill.
- `animate-bounce` on the scroll cue; bounce is banned.
- SFMono as the face; the house face is CommitMono.
