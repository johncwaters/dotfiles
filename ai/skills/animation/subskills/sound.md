# Sound

Only for a narrated piece. Send audio and scripts only to providers an extension's Sound section allows.

## Narration voice

- Write original lines in the chosen character voice, for example a bombastic founder. Never quote the reference work or name its characters, and never clone or imitate a real actor's voice.
- Write each line as spoken sentences, one fact plus one joke that does not cost the fact, then split it into timed captions. Clipped subtitle fragments made the synthesized voice sound awful.
- Swap out any line a reviewer says reads oddly or sounds like a threat. Name what is on screen ("Payments, database, CRM") rather than jokes about the narrator.
- Audition before voicing the script: voice one line with 3 to 5 premade ElevenLabs voices (the free plan allows only premade ones), publish an audition page, and let the carbon unit pick. Then voice every line with `eleven_multilingual_v2` at stability 0.4, similarity 0.8, style 0.45, speed 1.05; `eleven_v3` at stability 0 sounded worse. The output folder must exist first.
- Time the words locally, never through a hosted model: `uv run --with faster-whisper==1.2.1 --with numpy python <skill-dir>/scripts/word-times.py vo/line*.wav` prints each word's start in seconds. Copy each line's length into `voiceSeconds` and each caption's start into `captions: [[seconds, text], ...]`.

## In-page narration

Paste [templates/narration.js](../templates/narration.js) after `SUBTITLES` and keep its controls in the chrome: `<audio id="narration">` with the mix embedded as base64, an `#volume` range input, a `#sound-hint` "Click anywhere for sound" note, and `#pause`. The page needs `isPlaying` and `currentTime`, calls `syncNarration()` from `showTime` and `setPlaying`, reads `narration.currentTime` in `tick` while `isNarrationAudible()`, and calls `wireNarrationControls()` at start. The page must carry its own audio: a silent page next to a narrated MP4 was the first complaint.

## Effects and mix

Sound effects come from earshot's offline bank, run from the pinned commit; PyPI's `earshot` is an unrelated project, the CPU index keeps CUDA torch (2 GB) off the disk, and its Gemini critique stays off unless an extension's Sound section allows it; never set `GEMINI_API_KEY` otherwise:

```
earshot() { EARSHOT_OFFLINE=1 uvx --index https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match --from git+https://github.com/Leonxlnx/earshot@925ebe5 earshot "$@"; }
earshot sfx render <category/name> -o sfx/<name>.wav
```

Every later `earshot` command runs through that shell function, since earshot is not on PATH. `earshot sfx list` names the bank. Write a cue sheet whose times are page expressions, so cues follow the story when timings change, with clip paths relative to the sheet:

```json
{ "soundLevel": 0.45, "voices": [{ "clip": "vo/line01.wav" }], "sounds": [{ "clip": "sfx/thock.wav", "at": "SOURCES[0].connectAt + 0.1", "level": 0.45 }] }
```

```
node <skill-dir>/scripts/frames.mjs cues --page <page.html> --sheet cues.json
node <skill-dir>/scripts/frames.mjs mix --page <page.html> --sheet cues.json --out mix.wav
node <skill-dir>/scripts/frames.mjs audio-check --page <page.html>
```

`cues` prints real seconds plus an `earshotCues` list for `earshot timeline <file> --cues <list>`, which confirms each hit lands. `mix` ducks effects under the voice and normalizes to -16 LUFS; effects at full level drowned the voice. Embed the mix in the page as m4a, then `audio-check` must pass: it fails a page without in-page narration, volume control, sync, or pause.
