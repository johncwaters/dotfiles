# In-app

Motion inside a running app or game: a card attacking, an enemy revealing, a turn changing, a celebration, a status indicator, and interface chrome: buttons, panels, transitions. Interface chrome takes only the two bullets below on transform, easing, looping, and reduced motion; durations and the clip review are for events. The scene is the product's own components, so skip [concept](concept.md), [scene](scene.md), [sound](sound.md), and [render](render.md); apply [animation-principles](animation-principles.md).

- Animate what the carbon unit needs to follow. Every state change the rules care about (damage, a move, a phase change) gets a motion; one that only redraws gets none.
- One event per readable beat. When one action triggers several state changes, play them in sequence, cause before effect, rather than in one frame. Queue each event's motion and start the next when the last settles, so each result appears only after its cause.
- Durations come from the principles table: about 0.3 to 0.6 s per event. A chain of events stays under about 2 s in total, or later events shorten so a long turn does not stall play.
- Input during a running motion either skips it to its end state or queues behind it; it lands only on an end-state element.
- Animate transform and opacity only, easing out on exponential curves; these win over the principles table's easing.
- Pause anything looping while it is off screen, and under `prefers-reduced-motion` hold its first frame; every event still happens, as an instant state change.
- Review on the real app: record the sequence with the `capturing-ui` clip recorder (`~/.claude/skills/capturing-ui`, Clips), giving each event its own clip.json scene, and read the `<out>.scene-<n>.png` it writes per scene, checking that each beat shows one change and that the order matches cause and effect.
