# Third-party content

Most of this repo is original work. The paths below are vendored from upstream
projects and remain under their upstream licenses, not this repo's.

| Path | Upstream | License |
|---|---|---|
| `profiles/work/skills/posthog-querying/` | [PostHog/posthog](https://github.com/PostHog/posthog), `products/posthog_ai/skills/querying-posthog-data/` | MIT |
| `ai/skills/ai-slop-cleaner/` | [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), `skills/ai-slop-cleaner/` | MIT |
| `fonts/` | [CommitMono](https://commitmono.com) | SIL Open Font License 1.1 |
| `glimmervoid/sounds/` | two RuneScape Wiki audio clips (Jagex game audio) | private use only |

The first three permit redistribution with attribution; the sounds do not, so this repo stays
private while it carries them. Required notices follow.

## profiles/work/skills/posthog-querying/ (MIT)

Vendored from https://github.com/PostHog/posthog at
`products/posthog_ai/skills/querying-posthog-data/`, renamed and snapshotted at an
earlier upstream revision. PostHog's root `LICENSE` places everything outside `ee/`
under the MIT Expat license; `products/` is outside `ee/`.

`profiles/work/skills/posthog-error-triage/` is original to this repo. It is not vendored. It
names PostHog MCP tools and PostHog skill slugs so it interoperates with them, and
no upstream copy of it exists.

## ai/skills/ai-slop-cleaner/ (MIT)

Derived from https://github.com/Yeachan-Heo/oh-my-claudecode at
`skills/ai-slop-cleaner/`. Substantially reworded here (upstream's OMC-specific and
Ralph-workflow material removed), but the same workflow and structure.

## MIT notice

Applies to `profiles/work/skills/posthog-querying/` and `ai/skills/ai-slop-cleaner/`, under the
copyrights listed below.

```
Copyright (c) 2020-2026 PostHog Inc.      (profiles/work/skills/posthog-querying/)
Copyright (c) 2025 Yeachan Heo            (ai/skills/ai-slop-cleaner/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Everything else (hooks, hud, setup scripts, agents, commands, posthog-error-triage,
commit, code-review and release skills) is original to this repo.
