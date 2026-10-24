---
name: animating
description: Makes authored animations and motion inside running apps or games, covering storyboard, scene, motion principles, narration, sound, frame checks, test-audience review, and rendering. Authored pieces use one SVG page rendered to MP4 or PNG and published as a downloadable Artifact. Use for any animation request, "add animations", "make this animation better", an explainer, an animated poster or still, "make an animation like the reference", or motion craft questions.
---

# Animation

Authored pieces include narrated explainers, isometric "test chamber" clips, launch posters, onboarding animations, animated scenes, and characters. In-app animation sequences the product's own components so card attacks, enemy reveals, turn changes, celebrations, and status indicators read clearly. The reference trigger includes `make an animation like <reference>`.

One animation is one self-contained HTML page: an SVG scene driven by a single clock. The same page is the interactive Artifact, the downloadable HTML, and the source for the MP4 or a still. Keeping it one file means a fix lands everywhere with one rebuild.

Read each file under `subskills/` as you reach it:

1. [concept](subskills/concept.md): topic, assets, and the storyboard.
2. [scene](subskills/scene.md): the page contract, time, camera, and drawing.
3. [animation-principles](subskills/animation-principles.md): how anything in the scene moves.
4. [sound](subskills/sound.md): narration voice, word timing, effects, and the mix; for any piece with sound.
5. [review](subskills/review.md): frame sheets and the test audience, briefed from `templates/review-brief.md`.
6. [render](subskills/render.md): MP4 and publishing.

Then the subskill for the kind being made, which adds to every step above:

- [explainer](subskills/explainer.md): a narrated, stepped instructional piece.
- [comparison](subskills/comparison.md): a before/after piece that plays each side in turn.
- [poster](subskills/poster.md): one still frame of a scene.
- [in-app](subskills/in-app.md): motion inside a running app or game, built from its own components.

## Extensions

Each installed skill whose name starts with `animating-` extends this one with a machine's conventions. Load every one listed among your available skills before step 1, then apply each section it adds at the step that section names. Extensions win over this skill's defaults.

## Scripts

- `scripts/frames.mjs`: Checks frame sheets and audio, resolves cues, mixes sound, and renders MP4; run at review and render steps.
- `scripts/word-times.py`: Times narration words locally; run on voiced lines before setting caption timing.

## Boundaries

- Interface chrome motion (buttons, panels, transitions in a product UI) follows the `designing-ui` skill's motion step; animated scenes, demos, characters, and in-app event animation (game actions, reveals, celebrations) follow this skill.
- A clip recorded from a product's real components is the `capturing-ui` skill's clip recorder; its motion craft still follows this skill.
