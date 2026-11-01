---
name: auditing-brand
description: Audits a repo's brand against a typed brand bible. Lists every brand surface of any repo (colors, type, motion, shape, assets, copy) as targeted findings without judging them, validates a repo's brand-bible/ folder against the opinionated schema, and writes editor JSON Schemas for it. Use for "brand audit", "brand bible", "check brand consistency", "validate the brand bible", or consolidating a project's identity.
---

# Auditing brand

A repo's bible is `brand-bible/`, one YAML file per section named in `bible/schema.ts`. Every section is required, and the schema's caps, enums and refinements are the opinions. Dependencies live in this skill directory and are installed by `ai/install.sh`.

1. Validate the bible: `node ~/.claude/skills/auditing-brand/bible/load.ts <repo>/brand-bible`. It prints `{"ok":true}`, or exits 1 with every issue keyed by field path; fix each at that path.
2. For editor autocomplete, write the section JSON Schemas with `node ~/.claude/skills/auditing-brand/bible/write-json-schemas.ts <repo>/brand-bible/.schema` and point each YAML file at its schema with a first line `# yaml-language-server: $schema=.schema/<section>.schema.json`.
3. Take the census: `node ~/.claude/skills/auditing-brand/census.ts <repo> --out <file>.jsonl` writes one finding per line, sorted by file, line, column and kind. Each finding's `target` names the bible field it compares against, and `normalized` is its grouping key. `--summary` prints findings grouped by kind and normalized value instead. `--include` and `--exclude` take globs.
4. The census only lists, and judging each finding is the reader's job. Read the summary first to draft or check the bible, then compare each finding with the bible field its `target` names. A `skipped` finding names a file the census did not read and why.

## Scripts

- `census.ts`: the census CLI; lists files, scans them concurrently, targets, sorts and prints findings.
- `parse-css.ts`: reads stylesheets and CSS declarations from any source into findings.
- `findings.ts`: shared value classifiers, source locations and image header reading.
- `color.ts`: normalizes any CSS color literal to lowercase hex.
