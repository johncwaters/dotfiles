# Poster

A poster is one frame of the same scene. A node generator writes the SVG and sharp renders it to PNG at density 144. Brand fonts go in as paths through `@foliojs-fork/fontkit`, because librsvg does not load web fonts. Copy the generator to `poster.vN.js` before each round so any step can roll back, and crop the changed region to check it. Skip [sound](sound.md).

- Stats board: phrase every stat as a reduction so a shorter bar is always better, use one accent color for the new arm and one color for the baseline bar, and say both in the legend. Keep the raw-number caption (such as "57s vs 73s") neutral gray: it holds both arms' numbers, so a baseline-colored caption reads as bad. Keep the methodology line (models, apps, trials) in the footer only; repeated under the legend, it crowds the legend.
- Don't label a part with a direction. "Docs in" over a hatch that cubes come out of reads backwards; the stripes alone make it read as a dispenser.
- Alt text carries the headline and every number on the poster.
