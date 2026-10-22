# Review

## Check frames

```
node <skill-dir>/scripts/frames.mjs sheet --page <page.html> --times 1,2.6,4.7,6.6,9.5,11.3,13.3,16.8 --columns 4 --out sheet.png
```

Read every sheet. Pick times inside each beat and at each transition. Check for:

- labels covering logos or the subject;
- subtitles caught mid-fade (lines that run straight into each other need near-instant swaps);
- elements clipped by the camera or by other scenery;
- sprites that read as dust at small sizes;
- a final push-in that frames empty scenery.

## Test audience

Spawn four persona reviewers in parallel: the target viewer, a fan of the reference genre, a brand designer, and the owner of accuracy for the subject. Use Agent with `model: "opus"` and the standard `Scope:`, `Out of scope:` and `Definition of done:` lines. Each one reads the brief built from [templates/review-brief.md](../templates/review-brief.md) plus the sheet paths, scores the piece, and returns blocking and optional notes with frame times. Resume the same agents with SendMessage for later rounds so they judge what changed. Apply the blocking notes, keep accuracy over a joke, record the notes you rejected along with the reason, and repeat until no reviewer has a blocker.
