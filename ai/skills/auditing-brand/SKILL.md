---
name: auditing-brand
description: Audits a repo's brand against a typed brand bible. Validates a repo's brand-bible/ folder against the opinionated schema and writes editor JSON Schemas for it. Use for "brand audit", "brand bible", "check brand consistency", "validate the brand bible", or consolidating a project's identity.
---

# Auditing brand

A repo's bible is `brand-bible/`, one YAML file per section named in `bible/schema.ts`. Every section is required, and the schema's caps, enums and refinements are the opinions. Dependencies live in this skill directory and are installed by `ai/install.sh`.

1. Validate the bible: `node ~/.claude/skills/auditing-brand/bible/load.ts <repo>/brand-bible`. It prints `{"ok":true}`, or exits 1 with every issue keyed by field path; fix each at that path.
2. For editor autocomplete, write the section JSON Schemas with `node ~/.claude/skills/auditing-brand/bible/write-json-schemas.ts <repo>/brand-bible/.schema` and point each YAML file at its schema with a first line `# yaml-language-server: $schema=.schema/<section>.schema.json`.
