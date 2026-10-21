---
name: gauge-reader
description: >
  Read Gauge Agent Experience eval runs from evidence instead of grep. Use when
  asked to read, analyze, compare, or explain a Gauge batch or run ("what did
  the agents do", "why did Claude fail the docs eval", "did they read the
  docs", a cmv… batch or run id). Runs read.ts first, then answers only from its
  per-run table, marking anything the table cannot show as inferred.
---

# Reading Gauge runs

Earlier sessions grepped raw Gauge logs as text and had to retract claim after
claim: miscounted batches, a cause pinned on the wrong fetch, a value traced to
docs that arrived after the write. Every claim now starts from one table.

## Step 1: build the table

```
node ~/.claude/skills/gauge-reader/read.ts --batch <batch-id> [--batch <id> ...] [<run-id> ...]
```

It prints a markdown table, one row per run, and writes the full rows to the
`runs.json` path printed on the last line. Finished runs are cached under
`${XDG_CACHE_HOME:-~/.cache}/gauge-reader/runs/`, so reruns are instant; a row
marked `INCOMPLETE` is still running and gets refetched next time.

Facts (written value, pass or fail, provenance) appear only when a file in
`facts/` matches the run, or with `--facts <path>`. A run matches the first file
whose `promptPattern` matches its prompt, else `facts/<evalSetId>.json`; applied
case runs have no evalSetId, so a new task needs a `promptPattern`.
`docsUrlPattern` and `sdkPattern` classify where a value was seen, and each fact
is a regex with one capture group over the run diff's added lines plus the
expected value.

## Step 2: answer from the table

- Cite each claim by run id and column, or by the `runs.json` field behind it.
- A claim the table cannot show is labeled **inferred**, with what would settle it.
- Provenance reads `<origin>@<seq>`: the first tool output containing the
  written value before the write. A trailing `?` means the sighting falls
  inside the write window: after the first write that touched the value's file
  but before the write carrying the value, usually because a content-less
  Codex `file_change` opened the window, so the value may have been written
  before that sighting.
- `unlogged-web` means a web_event search or fetch happened before the write and
  no logged output held the value. Gauge does not log what those tools
  returned, so that origin is always inferred and always carries `?`.
- `none` means no web event and no sighting before the write: memory.
- `works check` is static and diff-only: env names the added code reads that a
  written `.env*` file or the final message lacks, and `proxy rewrites` only
  when a next.config rewrite source covers the `api_host` path.
  `rewriteRequestPath` is recorded but its mapping is left to the judged
  criterion; `env -` means the diff added no env read.
- `posthog-js` is the version the diff wrote to package.json; `-` means unchanged.
- `sandbox docs` counts requests leaving the sandbox only. Codex's built-in
  `web_search` fetches outside it and shows up in the `web search/fetch` column
  instead.

Go to the raw log in the cache only to quote an event the table already points
at, by its seq.
