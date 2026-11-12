# Sound

Any piece with sound. Narration voice applies only to a narrated piece; an effects-only piece skips it and still carries its mix in the page. Send audio and scripts only to providers an extension's Sound section allows; earshot's Gemini critique stays off unless one allows Google, so set `GEMINI_API_KEY` only when Google is allowed.

## Narration voice

- Write original lines in the chosen character voice, for example a bombastic founder. Keep lines free of quotes from the reference work and its character names; use voices free of cloning or imitation of real actors.
- Write each line as spoken sentences, one fact plus one joke that does not cost the fact, then split it into timed captions. Clipped subtitle fragments made the synthesized voice sound awful.
- Swap out any line a reviewer says reads oddly or sounds like a threat. Name what is on screen ("Payments, database, CRM") rather than jokes about the narrator.
- Audition before voicing the script: voice one line with 3 to 5 premade ElevenLabs voices (the free plan allows only premade ones), publish an audition page, and let the carbon unit pick. Then voice every line with `eleven_multilingual_v2` at stability 0.4, similarity 0.8, style 0.45, speed 1.05; `eleven_v3` at stability 0 sounded worse. The output folder must exist first.
- Time the words locally, excluding hosted models: `uv run --with faster-whisper==1.2.1 --with numpy python <skill-dir>/scripts/word-times.py vo/line*.wav` prints each word's start in seconds. Copy each line's length into `voiceSeconds` and each caption's start into `captions: [[seconds, text], ...]`.

## In-page audio

Paste [templates/narration.js](../templates/narration.js) after `SUBTITLES` and keep its controls in the chrome: `<audio id="narration">` with the mix embedded as base64, an `#volume` range input, a `#sound-hint` "Click anywhere for sound" note, and `#pause`. The page needs `isPlaying` and `currentTime`, calls `syncNarration()` from `showTime` and `setPlaying`, reads `narration.currentTime` in `tick` while `isNarrationAudible()`, and calls `wireNarrationControls()` at start. The page must carry its own audio, effects-only mixes included: a silent page next to a narrated MP4 was the first complaint.

## Effects and mix

Sound effects come from earshot's offline bank, run from the pinned commit; PyPI's `earshot` is an unrelated project, and the CPU index keeps CUDA torch (2 GB) off the disk:

```
earshot() { EARSHOT_OFFLINE=1 uvx --index https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match --from git+https://github.com/Leonxlnx/earshot@591fa3e earshot "$@"; }
earshot sfx render <category/name> -o sfx/<name>.wav
```

Every later `earshot` command runs through that shell function, since earshot is not on PATH. `earshot sfx list` names the bank. Write a cue sheet whose times are page expressions, so cues follow the story when timings change, with clip paths relative to the sheet:

```json
{ "soundLevel": 0.45, "voices": [{ "clip": "vo/line01.wav" }], "sounds": [{ "clip": "sfx/thock.wav", "at": "SOURCES[0].connectAt + 0.1", "level": 0.45 }] }
```

Key each cue to the timeline fields the page itself draws from, such as a scene's start plus its side's offset, excluding literal seconds, so retiming a scene moves its sounds. A sound on a long motion (a slide, a counter, a fill) follows the motion, not its first frame; these optional fields do that:

- `"until": "<expression>"` loops the clip until the motion ends, then fades it over 0.15 s.
- `"align": "peak"` lands the clip's loudest moment on `at` instead of its first sample; a whoosh or riser peaks well after it starts, and start-aligned ones sounded late.
- `"notBefore": "<expression>"` trims the head of a clip that would start earlier, such as a peak-aligned swish at a scene cut.
- `"clipAt": <seconds>` lands that second of the clip on `at` instead of its first sample, such as a music track's drop.
- `"filter": "<ffmpeg filters>"` shapes the clip after its head trim, such as a band-passed intro.
- `"fadeIn"` and `"fadeOut"` set the head-trim fade (0.05 s) and the `until` fade (0.15 s); `"stopBefore": <seconds>` ends an `until` that many real seconds early, leaving a gap.

## Music

Effects-only pieces still want music. Use a free CC BY track (incompetech's direct mp3 links work; credit `Music: "<title>" Kevin MacLeod (incompetech.com), CC BY 4.0` next to the post) and pick it with an audition page that switches tracks over the muted video: a synthesized bed was rejected. Lay it in as two cues on the same clip, both at the reveal with `clipAt` on the track's drop: a quiet intro (`filter` band-pass, `until` the reveal, `stopBefore: 0.12`, `fadeOut: 0.01`) and the full track (`notBefore` the reveal, `fadeIn: 0`, `until` the end with a long `fadeOut`). The thin intro and the short gap are what make the drop land. Keep effects sparse and quiet under music: one hit per real event, no typing or tap loops.

```
node <skill-dir>/scripts/frames.mjs cues --page <page.html> --sheet cues.json
node <skill-dir>/scripts/frames.mjs mix --page <page.html> --sheet cues.json --out mix.wav
node <skill-dir>/scripts/frames.mjs audio-check --page <page.html>
```

`cues` prints real seconds plus an `earshotCues` list for `earshot timeline <file> --cues <list>`, which confirms each hit lands. `mix` ducks effects under the voice when the sheet has voices (effects at full level drowned the voice), then sets the whole mix to -16 LUFS with one measured fixed gain and a limiter; dynamic loudnorm flattened a music drop. It then prints each cue's landing time and loudness, plus the loudness either side of each `until`, and marks `SILENT LANDING` on a cue that lands on nothing: fix each one, and check that every `until` reads quieter after than before, except one that hands off to another cue landing on it, such as a music intro before its drop. Embed the mix in the page as m4a, then `audio-check` must pass: it fails a page without in-page narration, volume control, sync, or pause.
