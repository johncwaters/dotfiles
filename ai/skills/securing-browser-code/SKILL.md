---
name: securing-browser-code
description: Audits any repo that ships third-party browser code (an SDK it has a module for, or a cross-origin script tag) against install-security practices, and names a fix for every failure. Both review gates run it before stamping. Use when a gate refuses a stamp with browser-code failures, or for "check browser SDK security", "audit my third-party scripts", or hardening a site's analytics or payments install.
---

# Securing browser code

Third-party code in a page runs with the page's full access, so the repo has to control which bytes ship and what they may load.

Run `node ~/.claude/skills/securing-browser-code/check.ts [--json] [repo]`. It exits 0 when every practice holds or the repo has no third-party browser code, 1 with one `FAIL <check> <path>[:line] <problem>. Fix: <how>` line per failure, 2 on bad usage, and 3 when the audit itself crashed. `writeStamp` runs the same audit for `/gating-reviews`.

Fix each failure in the target repo as ordinary work under that repo's review gate; the script only reports. Before calling a failure a false flag, trace the failing file upstream (why the repo tracks it, whether anything serves or references it): a file nothing ships is deleted or stripped in the target repo, and `check.ts` changes only when it misjudges a file the repo really ships.

## Live check

A declared policy counts only once the host reads the file declaring it, so the audit also fetches each deployed site's root and prints `NOTE live-csp <url> ...` when it serves no enforced policy or one `csp-unsafe` would fail. The exit code and gate blocking follow failures alone, since a fix cannot be served before it lands; gates probe only repos the carbon unit owns, since any checkout can name the URL, and record notes on the stamp. The probe refuses loopback, private, and link-local addresses on every redirect hop. Sites come from a tracked `.browser-sdk-sites.json` (a JSON array of URLs; `[]` turns the probe off), else from an `astro.config` `site`, the `homepage` of a `package.json` shipping browser code, or a `CNAME`.

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
- `lib/live.ts`: finds the deployed sites and judges the policy each one serves.
- `lib/sdk/`: one module per SDK: its packages, secret env names, secret literal patterns, and any SDK-specific check.
