---
name: securing-browser-code
description: Audits any repo that ships third-party browser code (an SDK it has a module for, or a cross-origin script tag) against install-security practices, and names a fix for every failure. Both review gates run it before stamping. Use when a gate refuses a stamp with browser-code failures, or for "check browser SDK security", "audit my third-party scripts", or hardening a site's analytics or payments install.
---

# Securing browser code

Third-party code in a page runs with the page's full access, so the repo has to control which bytes ship and what they may load.

Run `node ~/.claude/skills/securing-browser-code/check.ts [--json] [repo]`. It exits 0 when every practice holds or the repo has no third-party browser code, 1 with one `FAIL <check> <path>[:line] <problem>. Fix: <how>` line per failure, 2 on bad usage, and 3 when the audit itself crashed. `writeStamp` runs the same audit for `/gating-reviews` and `/converging-reviews`.

Fix each failure in the target repo as ordinary work under that repo's review gate; the script only reports.

## Fixes by check

- `exact-pin`: every direct dependency in every `package.json` names one version. Install with `--save-exact` and commit `"save-exact": true` in `.npmrc`, so a later install keeps it.
- `lockfile`: one committed lockfile covers each `package.json`. Keep the lockfile of the package manager CI and deploy use and delete the other.
- `frozen-install`: CI and deploy install from the lockfile as is: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`. It reads GitHub workflows and composite actions, `.gitlab-ci.yml`, `netlify.toml`, `vercel.json`, and Dockerfiles; a repo with no install command in any of them fails, because the platform default may rewrite the lockfile.
- `waiver-reason`: a waiver needs a reason a reviewer can judge.

## Waivers

A deliberate exception goes in a tracked `.browser-sdk-waivers.json` at the repo root, reviewed like code:

```json
[{ "check": "exact-pin", "paths": "examples/**", "reason": "docs samples track the latest minor" }]
```

`paths` is a glob matched against the failing path.

## Scripts

- `check.ts`: the audit CLI the gates and the carbon unit run.
- `lib/audit.ts`: lists tracked files once, picks the SDK modules a repo uses, runs every check, applies waivers.
- `lib/generic.ts`: the checks every repo with third-party browser code gets.
- `lib/sdk/`: one module per SDK: its packages, secret env names, secret literal patterns, and any SDK-specific check.
