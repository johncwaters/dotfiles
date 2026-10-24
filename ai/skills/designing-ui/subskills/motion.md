# Motion

- Animate transform and opacity only.
- Ease out on exponential curves only.
- Pause anything looping while it is off screen, and hold its first frame under `prefers-reduced-motion`.
- Animated scenes, demos, characters, and in-app event animation (game actions, reveals, celebrations) follow the `animating` skill (`~/.claude/skills/animating`), which owns motion craft; where its easing advice disagrees, the rules above win for interface chrome.
