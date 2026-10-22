---
name: animation
description: Make authored, scripted animations and still frames from them, such as narrated explainer videos, isometric "test chamber" instructional clips, launch posters, product-explainer clips, onboarding animations, and animated scenes or characters, as one self-contained SVG page rendered to MP4 (or PNG for stills) and published as a downloadable Artifact. Covers concept and storyboard, building the scene, camera and motion principles, narration voice and sound mix, frame checks, test-audience review, and rendering. Use for any animation, explainer, animated poster or still, "make an animation like <reference>", or motion craft questions for animated scenes.
---

# Animation

One animation is one self-contained HTML page: an SVG scene driven by a single clock. The same page is the interactive Artifact, the downloadable HTML, and the source for the MP4 or a still. Keeping it one file means a fix lands everywhere with one rebuild.

Read each file under `subskills/` as you reach it:

1. [concept](subskills/concept.md): topic, assets, and the storyboard.
2. [scene](subskills/scene.md): the page contract, time, camera, and drawing.
3. [animation-principles](subskills/animation-principles.md): how anything in the scene moves.
4. [sound](subskills/sound.md): narration voice, word timing, effects, and the mix; for any piece with sound.
5. [review](subskills/review.md): frame sheets and the test audience.
6. [render](subskills/render.md): MP4 and publishing.

Then the subskill for the kind being made, which adds to every step above:

- [explainer](subskills/explainer.md): a narrated, stepped instructional piece.
- [comparison](subskills/comparison.md): a before/after piece that plays each side in turn.
- [poster](subskills/poster.md): one still frame of a scene.

## Extensions

Each installed skill whose name starts with `animation-` extends this one with a machine's conventions. Load every one listed among your available skills before step 1, then apply each section it adds at the step that section names. Extensions win over this skill's defaults.

## Boundaries

- Interface chrome motion (buttons, panels, transitions in a product UI) follows the design skill's motion step; animated scenes, demos and characters follow this skill.
- A clip recorded from a product's real components is the social-images skill's clip recorder; its motion craft still follows this skill.
