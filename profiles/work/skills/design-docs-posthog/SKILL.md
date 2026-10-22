---
name: design-docs-posthog
description: Extension for the design-docs skill on a work machine. Adds PostHog's RFC conventions, PostHog data sources for cost and volume, and the Claude Docs and Google Docs editing lessons. Loaded by the design-docs skill itself; invoke design-docs instead of this skill.
---

# Design docs: PostHog

Each section applies at the design-docs step it names.

## Sources

- Volume and rates come from PostHog itself through the `posthog-querying` skill, or from the GitHub API for PR and run counts. The runs API caps a listing at 1,000 runs, so pull busy repos in windows of a few hours.
- Exclude `trunk-merge/` branch heads from PostHog/posthog PR volume: they are merge-queue copies of PRs already counted, and they were 1,301 of 11,152 heads in one week.

## Draft

- PostHog's RFC rule: the author writes the problem and the options themselves; never generate them.
- Load `longform-writing` before the first draft, as the profile's posthog_writing rule requires. It sets the sentences, and the draft step sets the shape.

## Evidence

- Price compute at the provider's published list price and name it (for example Modal sandbox seconds or Depot CI minutes), so a reader can check the rate without asking.

## Ship

- **Claude Docs.** Before the first edit, load the docs skill and read its editing guide. Block edits target `{"kind":"blocks","ids":[...]}`; `replace` takes its new content in `with`, and `replace` and `delete` need `ifRev`. A `find` target edits characters inside a block and keeps the author's highlights. Tabs sort by their order string in ASCII, so `A0` sorts before `W`, which sorts before `a0`. A `block_gone` error means someone removed that block: never re-create it.
- **Google Docs.** Load the google-workspace skill and read its Docs reference first. Drive's `read_file_content` renders the doc as Markdown, which escapes `#`, `_`, and `+` and leaves images out, and it once made correct links, code formatting, and a diagram look broken or missing. Judge a defect only from `read_doc`, run through the skill's `docs_index.py`.
- **New Google Doc.** Build the HTML for the Docs reference's Create step from [templates/google-doc.html](templates/google-doc.html), the team's format. Bare HTML imports as Arial with no paragraph gaps and unpadded equal-width tables, and restyling a long doc afterwards took 315 index-based requests, so style it at creation.
- **Layout check.** Run the Docs reference's PDF render before reporting. Where `render_export.py` fails for lack of `pdftoppm`, render the pages with `pypdfium2` and `pillow` in a scratch uv venv, then look at every page.
