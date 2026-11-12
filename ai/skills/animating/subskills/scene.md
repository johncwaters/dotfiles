# Scene

The scripts drive the page through this contract, so keep it:

- `#stage` is the SVG element that gets recorded.
- `renderAt(realSeconds)` draws one frame. `realTimeAt(storySeconds)` maps story time to real time, and `window.totalSeconds` is the loop length.
- Opening the page with the hash `#t<storySeconds>` shows a paused still at that story time.

Time-stretch: author everything in story time. A narrated window runs `narrationWindowSeconds(line)` real seconds from [sound](sound.md), the voice length plus lead and tail; the end card holds at least 5 s. Gaps between windows run at 1x. Key every story event a spoken word lands on with `voiceCue(lineIndex, wordSeconds)`, so a pipe connects as its name is said.

Isometric drawing: draw back to front by depth. A part that sits under another (a flange under a pipe) is drawn first, or it paints over the part above it.

Direct the eye with a camera shot list keyed to the narration windows: `{ at, centerX, centerY, zoom }`, eased between shots. Frame whatever the current line talks about. Frame every shot on panel edges (zoom is the frame width over the panel span), never mid-element, or the frame reads as cropped wrong. Make pop-ups appear where the camera already is, for example a browser window opening on the terminal screen rather than in a far corner.

A product feature is drawn inside the product's own chrome (top bar, sidebar, panes side by side, the real colors), sampled from the running app or a screenshot first, so it reads as part of the product rather than an outside app; dim the pane the beat is not about.

Page chrome: buttons have fixed labels (`<ui_button_labels>`), there is a dark-mode token set, and prefers-reduced-motion gets a still frame.
