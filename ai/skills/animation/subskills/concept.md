# Concept

## Topic and assets

- Choose the topic from the carbon unit's goals or roadmap notes, not from what animates easily.
- Find every earlier piece in the series before designing: the newest one is the style reference and the new one takes the next number. Check the Artifact gallery as well as local copies, because local folders lag the gallery.
- Fetch brand assets (fonts, logomark, mascot SVGs) into a scratch `brand/` folder for each run and note their license. Never commit them anywhere: restrictive brand licenses such as PolyForm Strict allow use in the company's own materials, not redistribution.
- Embed the assets as base64 at build time from `template.html` placeholders (`__FONT__`, `__MASCOT__`), so the published page has no external requests.

## Storyboard before code

Write a beat table in story time. Each row has the time, what is on screen, and the narration or caption it carries. Every narrated noun must be on screen when it is said. Give each beat one caption line per panel and each panel one hero number, and cut secondary labels: viewers lost track when a beat carried several lines. Write in the audience's words, plain units such as "% of one CPU core busy" rather than jargon or version ids. Check every product claim against what the product really prints or does by reading its source or docs; a funny line that misstates the product fails review.
