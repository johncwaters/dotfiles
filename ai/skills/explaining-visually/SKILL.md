---
name: explaining-visually
description: Explains issues, designs, and review findings on the live Glimmervoid whiteboard, one section per issue with a small picture inside each box, a proof box holding real output, and a fix box, then exports each section as a PNG for a PR comment. Use for "show me on a board", "explain this visually", "too much text", "use pictures", or walking the carbon unit through findings one at a time. A published diagram artifact belongs to drawing-whiteboards.
---

# Explaining visually

The carbon unit reads pictures before words. Text-heavy boxes and a separate composite image both failed in practice; what read clearly was one picture per box, inside the flow the boxes already draw.

## Input

The issues or ideas to explain, with the evidence behind each (a command and its output, quoted lines), and the Glimmervoid board to draw on: the one the operator opened beside the session, or a new one.

## Output

A board section per issue that the carbon unit can read top to bottom without the chat, and, when asked, one PNG per section.

## Step 1: Lay out one section per issue

Give each issue its own band of the board: a title box with the issue in plain words and a one-line subtitle, borderless at text size L with no icon or tone, then the parts the issue needs, in reading order: the contract or setup, before, after (what breaks), fix, proof. Frame a part only when it holds more than one box. For a break that only a future change causes, draw today's working contract as before and title the after part with the change that triggers it, such as "once the next release is latest". Keep each box to a title and at most three short lines; the picture carries the rest. Wire the flow left to right inside a band.

## Step 2: Give every box its role's icon and tone

Read `visual-language.json` and give each box but the section title the `boardIcon` and `boardTone` of its role (contract, proof, fix, failure, caveat, ghost, external, agent, system), so the same picture and color mean the same thing on every board. The board draws these icons itself. A change that triggers the break (a PR, a release) takes the system role, and a box with a picture keeps its role icon.

Only for a metaphor no built-in icon covers (a socket and plug for a contract, a folder moving while its id stays, a factory for CI, a trash can for a folder something deletes), draw a 320x180 SVG, starting from `examples/contract-socket.svg` or `examples/fix-declared-field.svg`. Keep text inside the picture to labels; the box title and lines carry the sentence. Run `node <skill-dir>/scripts/check-palette.ts <file.svg>` and fix every color or font it names, then attach the file with `whiteboard attach`, which takes only `path`, and set the returned media on its box.

## Step 3: Mark proof and fix

Put the proof in its own proof-role box holding either the command and its real output or the quoted lines with their file:line, placed under the box it proves and wired dashed with the label "proves". Quote the line verbatim, reading it from the source when the input only paraphrases it. Put a caveat-role box under the box it qualifies, wired dashed with no label. Title fix-role boxes with the upstream change (a declared field, a versioned name), not the test that would catch the break.

## Step 4: Check what the carbon unit sees

Run `whiteboard view` on each section's region and look for clipped or overlapping text in a picture, a picture that still shows an older idea after the fix changed, and wires crossing boxes. Fix the SVG or the placement and view again until the section reads cleanly.

## Step 5: Export for a PR comment

When the carbon unit wants the explanation on a pull request, first write the comment and each exported section's box titles and lines with `writing-in-voice` on its published path until its lint exits 0, passing proof-role box text to the lint as `>` quotes so it stays verbatim, re-viewing the section as Step 4 does after any box changes. Then `whiteboard view` each section by region and keep the saved PNG. Image hosts for PR comments are public and permanent, so ask before uploading, then upload with the image uploader the profile's `opening-prs` extension names and put the image above the comment's details block.

## Scripts

- `scripts/check-palette.ts`: fails an SVG using a color or font outside the `drawing-whiteboards` palette and the role colors in `visual-language.json`; run in Step 2 before attaching.

## Check

Each issue has its own section, every box but the section title carries its role's icon or a checked picture, every claim has a proof-role box with real output or quoted lines, and `whiteboard view` shows no clipped text.
