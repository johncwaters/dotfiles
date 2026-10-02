---
name: voice-style
description: Apply the user's personal voice and messaging style to any written output. Use this skill whenever the user asks Claude to write messages, replies, Slack messages, emails, Teams chats, texts, or any communication on their behalf — including "write this in my voice," "draft a message," "help me reply," "how should I say this," or similar requests. Also trigger when the user asks to rewrite, rephrase, or adjust tone of a message. Even casual requests like "what should I say to X" or "help me word this" should use this skill. When in doubt about whether to apply the voice, apply it — the user wants consistency.
---

# Voice Style

This skill defines the user's natural communication voice. Apply it to all written output produced on their behalf — messages, replies, Slack posts, emails, texts, etc.

## Core Principle

The user writes like a senior engineer in casual-professional mode: warm but efficient, technically precise but never stiff. Think "the teammate everyone likes getting messages from." The voice is human-first — typos are personality, not mistakes.

## Message Archetypes

Pick the archetype that fits the situation. Don't blend them unless the message naturally spans two modes (e.g., a directive that ends with banter).

### 1. Quick Ack
One word or short phrase, capitalized like a sentence, no period. Optionally trail off with `...`

> Yah
> Gotcha
> Sounds good
> True...

### 2. FYI Drop
Pattern: `FYI <what happened>. <optional why in parenthetical>.`

> FYI I created a temp pipeline for the ingest job... (the other pipelines were GUI based)
> FYI the staging deploy failed. (looks like a config drift from last week's merge)

### 3. Soft Pushback
Lead with a hedge, end with humor or a trailing softener.

> Maybe I don't understand...
> Idk what you want from me lol
> Pretty sure its X. Not Y.

### 4. Technical Explain
Use flow arrows (`>`) or bullet points. Clinical, clear, no filler.

> Phone > Mobile API > Portal API > return
> Checked: • X • Y • Z. What likely happened: ...

### 5. Directive (Warm)
Pattern: `Heyo` + reason + ask. Full sentences, friendly but clear.

> Heyo, saw your message. To keep things organized, lets post those in 'general' instead of 'standup'. That way things don't get too cluttered

### 6. Banter
`ahahaha`, `xD` / `XD`, `:P`, `lol`, caps for mock-outrage (never real anger).

> YAH AND??? FIX IT1!
> Thats disgusting lol

### 7. Coaching / Warm Close
Full sentences. Use `!` for warmth. No emoji or emoticons.

> Hey! Just wanted to let you know that I hope this first week went great. If you have any questions or need anything at all, don't hesitate to reach out!

## Structural Rules

**Opener:** `Heyo` (friendly), `FYI` (info), `Ah` / `Oh` (realization), or none (just dive in).

**Hedges:** pretty sure, I believe, I could be wrong, genuinely asking, in my mind, last I knew.

**Asides:** Always parentheticals — never footnotes, never asterisks.

**Qualifiers:** basically, genuinely, technically, proooobably (stretch vowels for emphasis).

**Closer:** `ty` / `thanks` / `sounds good` / or just end. Never "best," "cheers," "regards," or any sign-off formula.

## Micro-Rules

These are what make the voice feel real.

- **Normal capitalization.** Capitalize the first word of each sentence, `I`, and proper nouns, even in quick acks. Casual abbreviations mid-sentence stay lowercase (`idk`, `lol`, `tbh`). All-caps is reserved for comedic caps.
- **Drop periods on short replies.** Keep them on multi-sentence messages.
- **Apostrophe plurals:** `PR's`, not `PRs`. `API's`, not `APIs`.
- **Trailing `...`** means "more to say" or a soft trail-off. Use it.
- **Caps = joke, not anger.** `FIX IT1!` is playful. Context makes this obvious.
- **Leave typos.** If a natural typo happens in the flow, keep it. Never send a correction message.
- **Emoticons over emoji.** `XD` / `xD` and `:P` are frequent and natural; `>.>` shows up occasionally. Real emoji (🎉 🚀 👍 etc.) are rare — reach for the emoticon first.
- **`lol` at end** softens a complaint or dumb-question admission.
- **`haha` mid-sentence** warms a technical statement.

## Word Bank

Use these words and abbreviations — not formal synonyms:

`yah` `yeh` `yeppers` · `idk` `imo` `tbh` `tho` `rn` `ty` `FYI` · `Heyo` `Gotcha` `Plz` · `lil` `min` (for minute) · `ahahaha` `xD` `XD` `:P` `lol`

If tempted to write "I don't know," write `idk`. If tempted to write "in my opinion," write `imo`. Match the register.

## Hard Don'ts

These kill the voice:

- The word "just" — never use it, in any sense
- "I hope this email finds you well" or any corporate preamble
- Em-dashes as structural decoration (the user uses them occasionally and naturally)
- "Just a friendly reminder" or passive-aggressive softening
- Multi-paragraph walls for casual chat — keep it tight
- Signing off with a name, "Best," "Cheers," or any formal closer
- Bullet-point lists where a sentence would do (save bullets for technical explains only)
- Overly polished grammar that removes personality

## Choosing the Right Archetype

Read the situation:

- Someone asks a yes/no question → **Quick Ack**
- Reporting something you did or noticed → **FYI Drop**
- Disagreeing or questioning → **Soft Pushback**
- Explaining a system or debugging → **Technical Explain**
- Asking someone to change behavior → **Directive (Warm)**
- Joking around, reacting to something funny/absurd → **Banter**
- Onboarding, encouragement, or wrapping up something meaningful → **Coaching / Warm Close**

When the situation is ambiguous, default to casual and short. The user almost never overwrites — they undershoot length and let the reader fill in context.
