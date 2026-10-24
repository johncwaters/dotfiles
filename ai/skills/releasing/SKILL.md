---
name: releasing
description: Executes a versioned release for the current repo using its .claude/release-profile.json (deriving and saving that profile on first run). Preflight gates, changelog freeze, version bump, archetype-specific publish (tag-CI, workflow-dispatch, local script, or push-deploy), and evidence-based verification. Use when asked to release, ship, publish, cut a version, or bump and tag.
---

# Release

Profile-driven release runbook. All repo-specific knowledge lives in one tracked file per repo: `.claude/release-profile.json`. Use evidenced facts only: a required field that is absent or contradicts the repo state stops the release.

No program enforces the profile checks below; you apply them, and every check is blocking.

## Step 1: Load or derive the profile

1. Read `.claude/release-profile.json` in the repo root and [references/profile-schema.md](references/profile-schema.md) for its schema and field rules.
2. Check it against the linked schema (required fields present, `type` and `publish.trigger` from their enums) and against the repo: version file exists and parses, changelog path exists (unless `status: MISSING`), branches exist, referenced workflow files and npm scripts exist, tag prefix consistent. Any failure = stop, show it, fix profile or repo first.
3. **Present**: beyond the schema check, sanity-check judgment fields against reality (does the release-commit pattern match `git log` history, does the trigger archetype match how past releases actually shipped). Contradiction = stop, show the mismatch, ask whether to fix the profile or the repo.
4. **Absent, but a `.claude/release-profile.yml` is present**: it is the retired YAML format. Convert it field for field to `.claude/release-profile.json`, delete the YAML in the same commit, and continue at Step 1 item 2 rather than re-deriving from the repo.
5. **Absent**: derive it by surveying the repo (branches and their roles, CI workflows and triggers, version source file, changelog file and format, tag format and release-commit pattern from `git log`/`git tag`, deploy/publish mechanism, verification surfaces). Start from the linked schema, write the profile, re-run the Step 1 item 2 checks against it, show it to the carbon unit for review, and include it in the release commit. Leave out any field lacking evidence and say so.
6. The repo's own CLAUDE.md overrides everything (e.g. `releases run only through CI: dispatch and monitor, never build locally`).
7. **Live state beats cached notes.** Any profile field describing mutable remote state (a CI/CD variable, a store track, a feature switch) must carry the command that reads it live (convention: a `*_live_check` key). Run that command and act on the live value; a stale note about a release-gating switch is a safety bug, not a doc nit.

## Step 2: Preflight (every release)

Stop on any failure; fix upstream while keeping every gate enforced.

0. Re-run the Step 1 item 2 checks, plus: HEAD is not detached, and the tag this release would create does not exist yet.
1. Working tree clean; on a branch the profile allows (integration or release_from; starting from the integration branch is legitimate, so this one warns rather than blocks).
2. Integration and release branches synced (fetch both; report divergence and keep updates non-forced).
3. CI green on the tip commit (`gh run list --branch <branch> --limit 1`) when the repo has CI. This is enforced, not advisory: red = pull the failure (`gh run view <id> --log-failed`), report it, and **block** — tagging into a red pipeline fires the expensive release job into the same failure.
4. Run the profile's `gates.pre_tag` commands **locally** (lint, typecheck, tests). Listing them in the profile is not running them; local execution catches what a divergent CI environment (line endings, platform deps) would only surface after the push.
5. Multi-target repos (`targets` in the profile): diff the paths since the last release tag and list which targets this release touches. Every touched target gets shipped or explicitly deferred with the carbon unit's sign-off; silence is not an option.
6. Version sanity: `version_file` value vs latest tag; the new version must be a valid increment with a fresh tag and build number.
7. Changelog `[Unreleased]` has content. Empty: draft it from conventional commits since the last tag, show for polish, and release only a nonempty section. `status: MISSING`: backfill a Keep-a-Changelog file from existing tags + `git log` before this release ships, then drop the MISSING marker.

## Step 3: Prepare

1. Freeze `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` per the repo's format; generate store notes when the profile defines them (respect caps).
2. Bump `version_file` (and lockfile when the ecosystem pairs them).
3. Land the release commit through `/committing` with `--promote`, with the repo's exact `release_commit_pattern` as its subject. Nothing else rides in the release commit except a newly derived profile on first run. `/committing --promote` pushes the resolved mainline itself, so present the release commit and get carbon-unit approval before running it. This path requires `git.release_from` to equal preflight's `policy.resolved.mainline` and `policy.afterCommit` to be `promote`; when either does not hold, stop and report.

## Step 4: Execute, by archetype

**Carbon-unit approval before every irreversible step** (push, tag push, publish, store promotion). Present what will run and wait.

Every branch and tag push in this step goes through the release push script, run from the repo root. After `/committing` promoted the release commit, fetch, create the annotated tag on the promoted `release_from` tip (origin's tip), then run:

```
node "$HOME/.claude/skills/releasing/publish.ts" --tag <tag> [--branch <integration>]
```

Pass `--branch <integration>` when the release fast-forwards the integration branch. Leave `release_from` out of `--branch`: `/committing` already pushed it, and the script checks the tag against its remote tip. It fast-forwards only the profile's `git.integration` and `git.release_from`, and pushes the named annotated tag only when it matches `tag_format` and sits on the `release_from` tip, all in one atomic push. It prints one JSON outcome; `PUBLISHED` (exit 0) covers a rerun that finds everything already up to date, and any other outcome stops the release per the failure posture below.

- `tag_push` (CI releases on tag, e.g. Electron/NSIS or store upload): promote integration to release branch ff-only, the bump commit lands on the release branch via `/committing` promote (Step 3 item 3), **verify the target tag does not already exist** (`git tag --list <tag>` must be empty; the preflight tag check ran pre-bump and only covered the previous version), create the **annotated tag on that exact commit**, run the release push script with that tag (plus `--branch <integration>` when integration moves), then `gh run watch` the release workflow to completion. **Unsigned-build feed stop:** when a live auto-update feed is enabled (confirmed by a live check) and builds are unsigned, the tag push auto-updates real carbon units to an unsigned build; require explicit carbon-unit confirmation that names exactly that consequence before pushing the tag.
- `workflow_dispatch` (repo owns its release workflow): `gh workflow run <workflow>` with the profile's inputs, monitor the produced PR/run, confirm the downstream tag and release workflow complete. Leave execution of those steps to the workflow.
- `local_script` (e.g. npm publish script): run the repo's script only after commits are in place; afterwards sync the release branch through the release push script so it does not drift behind; confirm registry state and check what landed before re-running a partially failed publish.
- `push_to_main` (host deploys on push, tag is metadata): merge the integration branch into the deploy branch first when the release content lives there, the bump commit lands on the deploy branch (the deploy branch is `release_from`) via `/committing` promote, then tag it and push the tag with the release push script, then watch the host deploy. If the host reports nothing headless (no CI status, no CLI token — Netlify posts nothing to GitHub by default), verify with a **live-site content marker**: a class name or string literal introduced by this release, grepped from the served CSS/JS bundles. After release, sync the integration branch back per the repo's flow, pushing it with the release push script and the release tag.

## Step 5: Verify and report

1. Run every `gates.post_release` command; collect every `gates.evidence` item.
2. "Released" means the evidence bundle is complete: tag exists and points at the release commit, CI run green (when CI), artifact observable where carbon units get it (registry version, store track, live site, update feed).
3. Report: version, evidence list with values, anything skipped and why, and the profile's rollback steps verbatim (the moment you need them is the wrong time to derive them).

## Failure and rollback posture

- Forward-fix first: a broken release gets a new patch version, keeping previous versions and tags intact.
- npm: `npm deprecate` the bad version and point `latest` back; keep the version published.
- Play: halt the staged rollout, fix, ship next build number; staged rollout defaults 10 -> 50 -> 100 when the profile enables it.
- Netlify: lock auto-publish, publish the previous deploy, fix forward.
- Electron feed: pull/point the feed at the prior installer only if the app is unusable; otherwise forward-fix; use only a version the updater has yet to see.
- A release that fails mid-flight: report exactly which step and item, what is already irreversible (pushed tag? published package?), and the safe continuation. Check the state before retrying.

## Scripts

- `outcome.ts`: Defines and emits publish outcomes; imported by publish.ts during execution.
- `publish.ts`: Validates and atomically pushes release tags and allowed branches; run for every branch or tag push in Step 4.

## Usage

- `/releasing` — full flow for the current repo
- `/releasing --dry-run` — Steps 1-3 plus a printed execution plan; nothing pushed, tagged, or published
- `/releasing --profile-only` - derive/refresh `.claude/release-profile.json` and stop
