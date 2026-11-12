# Concept

## Topic and assets

- Choose the topic from the carbon unit's goals or roadmap notes, not from what animates easily.
- Find every earlier piece in the series before designing: the newest one is the style reference and the new one takes the next number. Check the Artifact gallery as well as local copies, because local folders lag the gallery.
- Fetch brand assets (fonts, logomark, mascot SVGs) into a scratch `brand/` folder for each run and note their license. Keep these assets out of every commit: restrictive brand licenses such as PolyForm Strict allow use in the company's own materials, not redistribution.
- Embed fonts and images as base64 at build time, so the published page has no external requests.

## Storyboard before code

Shape the beats with the `storytelling` arc: what is, the villain, the reveal, the hero moment early, one more thing. Write a beat table in story time. Each row has the time, what is on screen, and the narration or caption it carries. Every narrated noun must be on screen when it is said. Give each beat one caption line per panel and each panel one hero number, and cut secondary labels: viewers lost track when a beat carried several lines. A piece with no voice carries its words on title cards, each with its own beat: the scene freezes and dims behind the card through holds in the story-to-real time map, the hold runs 1.0 s plus 0.2 s per word, and no card ever sits over action; captions over moving scenery and fast in-out cards went unread. Set the cards in the repo's own headline style (its social templates), with no side bars or underlines. Mark a failure beat by striking through its line. Write in the audience's words, plain units such as "% of one CPU core busy" rather than jargon or version ids. Check every product claim against what the product really prints or does by reading its source or docs; a funny line that misstates the product fails review.
