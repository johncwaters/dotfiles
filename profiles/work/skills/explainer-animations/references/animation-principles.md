# Disney's twelve principles, applied to a clock-driven SVG

Source: Frank Thomas and Ollie Johnston, *The Illusion of Life: Disney Animation* (1981). Summary: [Twelve basic principles of animation](https://en.wikipedia.org/wiki/Twelve_basic_principles_of_animation).

Every motion here is a pure function of time, so each principle becomes a term in an object's state at a given age. The values are the ones the Docs Test Chamber 04 loop shipped with, at a 2 s beat; scale them with the beat.

| Principle | What it means | How to apply it here |
|---|---|---|
| Squash and stretch | Weight and give, at constant volume | Scale about the object's base point in screen space: `scale(1 + s * 0.6, 1 - s)`, with `s` positive for squash and negative for stretch. Squash about 0.28 on a landing, then settle with a damped wobble, `s * e^(-8t) * cos(22t)`, over about 0.45 s. Stretch about 0.14 to 0.15 along a fall or a hop. |
| Anticipation | A small opposite move before the main one | Crouch (squash up to about 0.22, eased in) over the 0.25 s before a hop or a beam-out. |
| Staging | One clear focus at a time | Only one thing moves fast at once. Make the key event (the grill wake-up) the brightest and busiest spot, and keep the stats board still. |
| Straight ahead and pose to pose | Draw it in sequence, or keyframes then in-betweens | Pose to pose: compute the state from phase windows (`emerge`, `fall`, `belt`, `hop`, `top`) keyed to age, never by stepping the state forward frame by frame. |
| Follow through and overlapping action | Parts keep moving after the main body stops | Let the wobble after a landing outlast the move itself. Offset secondary loops (sparks, the mascot's tilt) in phase from the main beat. |
| Slow in and slow out | Ease toward and away from rest | Ease into a rest (`easeOutQuad` for coming out of a hatch) and away from one (`easeInCubic` for a beam-out). Keep the belt and the horizontal part of an arc linear, since a conveyor and gravity do not ease. |
| Arcs | Natural motion follows curves | Fall and hop on a parabola: lerp x and y, and add `height * 4p(1 - p)` to z. |
| Secondary action | A supporting move that adds life | Twinkling sparks, a gentle mascot tilt, belt slats crawling. Transform a brand mascot only as a whole image; never edit or rig it. |
| Timing | The number of frames sets weight and mood | Hold one beat: spawn every 2 s. A hop of about 0.6 s reads as light, and a landing settle under 0.5 s keeps it snappy. |
| Exaggeration | Push the pose past realism for clarity | A small joy hop (0.3 high, 0.4 s) right after a cube wakes up sells the change better than a color swap alone. |
| Solid drawing | Consistent volume and perspective | Use one projection (`iso`) for everything, and draw back to front by depth (§4). Split an object crossing a plane into two slices, before and after the plane, each clipping its own face. |
| Appeal | Charm and readability | Faces carry mood (sleepy, then wide-eyed). Keep shapes simple and inked, and read every new pose on a frame sheet. |

## Seamless loops

- Make the loop length a whole number of every period inside it: the spawn beat, the palette cycle, the slat spacing divided by the belt speed, and the twinkle and tilt periods. The 10 s loop is 5 beats × 2 s, 5 palettes, and 25 slats at 0.3 apart.
- Derive each object from `age = loopSeconds - index * beat`, with `loopSeconds = realSeconds mod totalSeconds` (the time `renderAt` received, wrapped to the loop), and iterate the indexes alive across the wrap, so the frame at 0 is the next frame after the last one. Check by tiling the first and last frames of the MP4.
- Hand-offs must not overlap: an object leaving a slot finishes before the next one arrives.
