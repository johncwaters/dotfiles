# Visual evidence for PostHog PRs

The repo's own guide wins over this file and the core capture guide: `agents/browser-screenshots.md` and `agents/reviewers-guide.md` in `PostHog/posthog.com`, the `hogli pr:*` commands in `PostHog/posthog`.

- **posthog.com dev server:** `GATSBY_MINIMAL=true PORT=<port> pnpm start` builds pocket guides, docs, and handbook in minutes; wait for `success Building development bundle`.
- **posthog.com capture flags:** `--local-storage '{"theme":"{mode}","siteSettings":{"colorMode":"{mode}","theme":"{mode}"}}'` (both keys, or theme and control disagree) and `--dismiss 'text=Legally-required cookie banner >> xpath=ancestor::*[.//button][1] >> button'`.
- **Upload:** posthog.com: `gh pr-assets image --yes --pr <n> <files>` (`--yes` only after the approval step). PostHog/posthog: `hogli pr:upload-image`. Pass the `gh pr-assets` output to `markdown --uploaded`.

## posthog.com checks beyond the pictures

- **Markdown export.** `/docs`, `/handbook`, `/pocket-guides` and others also ship as `<page>.md` for Copy page and agents, converted from built HTML by `gatsby/turndownService.ts`. A component change can leak controls into it. Minimal builds skip `.md`, so run the exported functions (`extractMainContent`, `preprocessHtmlForTabs`, `createTurndownService`, `postProcessMarkdown`) on the page HTML with `node`, and prove the harness by reproducing the live `.md` from the live page first.
- **Deploy preview** is Cloudflare Pages, not Vercel, and builds on drafts. Its link is in the `cloudflare-pages-preview` PR comment; rerun the same checks there before marking ready.
