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

Give each issue its own band of the board: a title box with the issue in plain words and a one-line subtitle, then frames for the parts the issue needs, in reading order: the contract or setup, before, after (what breaks), fix, proof. Keep each box to a title and at most three short lines; the picture carries the rest. Wire the flow left to right inside a band.

## Step 2: Draw one picture per box

Draw a 320x180 SVG for each box, as a metaphor rather than a screenshot: a socket and plug for a contract, a factory for CI, a form with blanks for a template, a shelf and a trash can for a folder something deletes, a terminal for real output. Start from `examples/contract-socket.svg`, `examples/fix-declared-field.svg`, and `examples/proof-terminal.svg`. Keep text inside the picture to labels; the box title and lines carry the sentence, so a caption inside the SVG only repeats it. Attach each file with `whiteboard attach` and set the returned media on its box.

## Step 3: Mark proof and fix

Put the proof in its own pink box holding the command and its real output, wired dashed with the label "proves" to the box it proves. Make fix boxes green and title them with the upstream change (a declared field, a versioned name), not the test that would catch the break.

## Step 4: Check what the carbon unit sees

Run `whiteboard view` on each section's region and look for clipped or overlapping text in a picture, a picture that still shows an older idea after the fix changed, and wires crossing boxes. Fix the SVG or the placement and view again until the section reads cleanly.

## Step 5: Export for a PR comment

When the carbon unit wants the explanation on a pull request, `whiteboard view` each section by region and keep the saved PNG. Image hosts for PR comments are public and permanent, so ask before uploading, then upload with the image uploader the profile's `opening-prs` extension names and put the image above the comment's details block.

## Check

Each issue has its own section, every box has a picture, every claim has a pink proof box with real output, and `whiteboard view` shows no clipped text.
