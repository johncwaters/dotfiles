---
name: measuring-compaction
description: Measures what Claude Code auto-compaction costs and saves from local session transcripts, covering precomputed vs idle compactions, context dropped from re-reads, which sessions compact, prompt-cache payback per compaction, and how much compacting sessions already delegate, and renders house-style PNG cards of it. Use for "is my auto-compact window right", "rerun the compaction analysis", "does compaction bust the cache", or graphics for a post about compaction.
---

# Measuring compaction

Run `node ~/.claude/skills/measuring-compaction/report.ts [--since YYYY-MM-DD] [--json <report.json>] [--graphics <dir>]`. It reads every session under `~/.claude/projects` that started on or after `--since` (default 30 days ago), prints the figures, and with `--graphics` writes `reread`, `sessions`, `payback`, `delegation`, and `idle` PNGs at 3200x1800.

Dollar figures use the dated API price table in `report.ts`, so they are API-equivalent, not a subscription bill; refresh it from the `claude-api` skill when prices change, since a model missing from it is priced as Opus 5.5 and named in the first output line.

Payback savings count only the calls until the next compaction, so they are a floor. The summary call forks the warm prompt cache, so "summary read from cache" is the expected cost and "summary uncached" the worst case; summary tokens are characters divided by 4.

## Scripts

- `report.ts`: reads the transcripts, prints the figures, and writes the JSON and the cards.
- `graphics.ts`: builds the five cards from the report and screenshots them through headless Chrome.
