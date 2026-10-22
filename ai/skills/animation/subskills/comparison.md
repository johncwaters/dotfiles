# Comparison

A before/after piece: two panels, the old behavior beside the new, one measured claim per beat.

- Concept: label the sides BEFORE and NOW. Each beat's caption is two rows, "Before: <what happened>" and "Now: <what happens>", each in its panel's color; a regression's Now row reads "Worse: ..." in the fail color instead. Captions that described the scene instead of the change ("left alone, ...") read as noise.
- Scene: play the sides in turn, never at once, so the eye has one place to look. BEFORE runs while NOW waits dimmed (opacity 0.2); then NOW runs while BEFORE dims to 0.35; then both hold together about 1.5 s. Frame the active panel in its color, and reveal each caption row with its side. Lay each scene out from `before`, `head` and `hold` lengths in one timeline array that the page and the cue sheet both read. Clip each panel to its own rect with a `clipPath`: a sliding bar crossed into the neighbor panel before one did.
- Sound: a swish at each focus switch (scene start plus `before`).
- End card: the worse color goes only on the worse value of a pair; the better value and the labels stay neutral or the accent.
- Review: sheet a frame mid-BEFORE, mid-NOW and in the hold of every scene.
