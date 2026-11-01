---
name: recording-demo-videos
description: Records a product demo video of a whole running app, the kind a website hero or launch post plays, with a storyboard of cause-and-effect beats, keyboard-first navigation, seeded state, replayed agent or backend activity, a 60 fps CDP screencast, and AV1 plus H.264 web encodes checked before shipping. Use for "hero video", "demo video", "re-record the site video", or a recording of the real app working, not one component.
---

# Recording demo videos

A demo video sells one story on the real app. `capturing-ui` owns stills and the frame-exact clip of one component; this skill owns a realtime recording of the whole app, where live processes, sockets and timers rule out a frozen page clock. Worked example: `harness/site-capture` in the glimmervoid repo (record, replay, capture, encode).

## Story

The arc (pain, hero action, result, one idea) comes from the `storytelling` skill's Demos section, and motion timing from `animating`. These are the recording-side rules.

1. **Storyboard before recording.** A table of who is on screen, the state each starts in, and each beat with its time. Get it approved first: a re-record of live agents costs money and an hour, a table costs a minute.
2. **Every beat shows cause and effect.** A session waiting for input gets answered on screen and visibly continues. A viewer reads a beat that only parks and moves on as the app hanging; that was the first complaint about the glimmervoid hero.
3. **Start states differ.** Stagger start times, with negative offsets for work already under way, so the opening frame shows a range of states instead of everything booting at once.
4. **Seed rich state, then have it changed.** Load a finished-looking document, board or dataset before recording and prompt the agent to edit it. A cheap model building from blank produces a basic result that reads as boring.
5. **Cut beats that do nothing.** A shortcut with no target, or a click whose view is already open, is dead air; remove it rather than retime it.

## Driving the app

1. **Keyboard first.** Move with the shortcut the product teaches. Click only what has no key, and show the click with a cursor overlay that glides to the target and pulses, or the view appears to change by itself.
2. **Press until focused, bounded.** Press the key, wait, check the focus marker for the target, repeat up to a cap, then fail loudly naming the target. A fixed number of presses breaks the moment attention order shifts.
3. **Focus traps swallow shortcuts.** An embedded terminal, editor or input that holds focus eats app keys. Move focus to neutral app chrome before the shortcut, and report the trap as a product issue.
4. **Verify connections the story relies on.** A chip, badge or link that only renders once two things are joined needs that join in the recording script, checked in a frame, not assumed.

## Live activity

1. **Record once, replay deterministically.** Run the real agents or backend once on throwaway tasks with the cheapest model that does the job, keep their output and timing, and replay it into an isolated instance for every capture. Retakes then cost nothing and match each other.
2. **Gate replay on the operator's answer.** Record each answer as input; on replay, pause that timeline at the answer until the key arrives from the capture script, then shift the rest by the wait. Otherwise the session continues before anyone answers.
3. **Pull latest before a billed re-record.** Recordings carry the app's current UI; recording on a stale branch means doing it twice.

## Capture

1. **Check memory first.** `free -m`, and wait or free space below a few GB available. Under memory pressure Chrome dies with `Target crashed` and agent processes stall in running, which reads as a script bug.
2. **60 fps from CDP screencast at 1x.** Playwright `recordVideo` is fixed at 25 fps. `Page.startScreencast` with `format: 'png', everyNthFrame: 1` and an ack per frame gives timestamped frames; at device scale 2 it fell to about 12 fps, so pick frames over pixels.
3. **Assemble by timestamp.** Write an ffconcat file giving each frame `duration` until the next frame's timestamp, then let `fps=60` make constant frame rate. Frame-count assembly drifts against the real timeline.
4. **Read the frames at every beat** and check the run log lists each beat; exit 0 only proves the script finished.

## Encode and ship

```
ffmpeg -f concat -safe 0 -i window.ffconcat -vf fps=60,format=yuv420p -an -c:v libaom-av1 -crf 22 -b:v 0 -cpu-used 3 -g 600 demo.webm
ffmpeg -f concat -safe 0 -i window.ffconcat -vf fps=60,format=yuv420p -an -c:v libx264 -preset veryslow -tune animation -crf 17 -profile:v high -level:v 4.2 -g 600 -movflags +faststart demo.mp4
ffmpeg -xerror -i demo.webm -f null -
```

1. Ship AV1 webm first and H.264 mp4 as the fallback `<source>`, with `preload="metadata"` and a poster. A 1440x900 UI demo landed near 1 MB AV1 and 1.6 MB H.264 per 30 s.
2. Decode-check every output with `-xerror`; a truncated encode still plays its first seconds.
3. A README GIF needs `palettegen=stats_mode=diff` and a low frame rate, and still runs several MB; link the video when size matters.
4. **Confirm the deploy, not the push.** `curl -sI <url>` and compare `content-length` with the local file. Same-URL assets stay cached in the viewer's browser, so tell the carbon unit to hard-refresh, or give the files a content hash in their names.
