# Visual evidence for PostHog PRs

The repo's own guide wins over this file: `agents/browser-screenshots.md` and `agents/reviewers-guide.md` in `PostHog/posthog.com`, the `hogli pr:*` commands in `PostHog/posthog`. This file carries what those guides leave to the agent's machine.

## Order, and why

1. **Own dev server port.** Check `lsof -iTCP:<port> -sTCP:LISTEN` first. Another worktree's server on the same port answers `localhost` and silently serves the old code, so a before/after grid shows no change. posthog.com: `GATSBY_MINIMAL=true PORT=<port> pnpm start` builds pocket guides, docs, and handbook in minutes; wait for `success Building development bundle`.
2. **Before state from mainline, not memory.** Uncommitted edits in the files first go to `git stash push --include-untracked -- <files>`. Sort the files with `git diff --no-renames --name-status origin/<mainline>...HEAD -- <files>`: `A` is added, `D` is deleted, the rest modified. Then `git restore --source=origin/<mainline> --worktree -- <modified> <deleted>` and delete the added files, capture, `git restore --source=HEAD --worktree -- <modified> <added>` and delete the deleted files again, and `git stash pop` if you stashed. `--worktree` leaves the index untouched, and no per-file backup means two `index.tsx` cannot clobber each other. Wait ~30s for hot reload between states.
3. **Capture with `scripts/evidence.mjs`.** Copy it to the scratchpad and run `npm i playwright-core gifenc pngjs` there; it drives the installed Google Chrome, so nothing downloads a browser and no `ffmpeg` is needed.
   - `grid --url --selector --state before|after --area <slug> --out <dir>`: light and dark at 640px and 1440px, fresh context per shot, named `<state>-<area>-<mode>-<width>.png` so the later commands can pair them.
   - `gif --url --selector --target --out <file>.gif`: hover then click on `--target`, for anything that zooms, animates, or reacts. Writes three frame PNGs beside it; read them, since a GIF cannot be checked by opening the file.
   - posthog.com flags: `--local-storage '{"theme":"{mode}","siteSettings":{"colorMode":"{mode}","theme":"{mode}"}}'` (both keys, or theme and control disagree) and `--dismiss 'text=Legally-required cookie banner >> xpath=ancestor::*[.//button][1] >> button'`.
4. **Console, both sides.** `grid` prints the console errors it saw; the PR claims "no new errors" only when the before and after sets match.
5. **Exercise, do not just look.** Click the control and read the clipboard, check the toast, check links. A still proves layout, not behavior. Wait for hydration before clicking; a click on static HTML does nothing and reads as a bug.
6. **Show before uploading.** `sheet --dir <dir>` writes `preview.html`; `open` it and get approval for the exact files, including the GIF and frames under Other files. Uploads are public and permanent.
7. **Upload per repo.** posthog.com: `gh pr-assets image --yes --pr <n> <files>` (`--yes` only after step 6). PostHog/posthog: `hogli pr:upload-image`. Elsewhere: `gh pr edit <n> --attach` with the approved body via `--body-file`, only after Step 6 has created the PR (or in update mode). Verify each URL: `curl -sL -o /dev/null -w '%{http_code} %{size_download}'` must match the local byte count.
8. **Embed.** `markdown --uploaded <gh pr-assets output> --area <slug> --heading <title>` prints the four-row before/after table the reviewer's guide asks for; it refuses when an upload is missing, so no cell is silently empty.

## posthog.com checks beyond the pictures

- **Markdown export.** `/docs`, `/handbook`, `/pocket-guides` and others also ship as `<page>.md` for Copy page and agents, converted from built HTML by `gatsby/turndownService.ts`. A component change can leak controls into it. Minimal builds skip `.md`, so run the exported functions (`extractMainContent`, `preprocessHtmlForTabs`, `createTurndownService`, `postProcessMarkdown`) on the page HTML with `node`, and prove the harness by reproducing the live `.md` from the live page first.
- **Deploy preview** is Cloudflare Pages, not Vercel, and builds on drafts. Its link is in the `cloudflare-pages-preview` PR comment; rerun the same checks there before marking ready.
- **Issue or PR.** Its AGENTS.md routes visual changes spanning several pages to an issue; a PR that goes ahead anyway says why in the description.
