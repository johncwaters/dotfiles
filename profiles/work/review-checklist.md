# Work review checklist

Mined from the wizard maintainer's reviews (edwinyjlim, PostHog/wizard #1012–#1358) and his Slack feedback. Each item names the lane that owns it; apply only the items in your lane. A hit is a finding in your normal format, not a quote of this file.

## structure

- Code sits in the layer that owns it. A helper other services will call belongs in the shared layer, not under one consumer (#1358 moved `oauth-session` out of `/agent`).
- Product or domain knowledge stays out of infrastructure. Agent instructions that are "just packaged english" belong in the context-mill skill a program loads, not in a global prompt or commandment every program ships.
- A rule that exists in two places must agree in both, including a sibling repo (context-mill skills, workbench). A change that fixes one conflict and opens another against the other copy is a finding.
- Reuse an existing name, env var, or type before adding one (#1163 "can't we use `MCP_URL`?", #1148 use `ErrorCode` not `string`). Names read clean (#1148 `PhwError` renamed).
- A new import edge must pass the arch fence (`pnpm test:arch`); a local type beats a cross-layer import (#1323).
- Cross-repo changes state merge order (#1235 "merge this first before context-mill#390").
- Prompt text has structure: sections, headers, or tags, not one long run-on rule.

## code

- Order and latch hazards that silently kill a behavior: a flag set before its guard, a push before a cache fills, a first call that arrives before consent is knowable (#1184, #1323).
- Two values derived from the same event must agree; an explicit input wins over an inferred one (#1323 hook outcome vs `status`).
- One bad input must never disable a feature for the rest of the run (#1323 blank task label stopped run sync). Be lenient where the model or user can send empty or unknown values.
- An empty collection is not a "clear" command unless the API says so (#1323 empty snapshot wiped earlier rows).
- On a fatal task, cancel siblings and pending user asks before waiting on them (#1293).
- Changed return shapes are updated at every caller (#1303 `failure` replaced `error`).
- Downstream consumers of a moved endpoint or renamed thing are updated: health checks, CI, smoke tests (#1224).
- User-input waits bound the run. A prompt-only limit ("a couple of attempts") on something that can block 20 minutes per call is unbounded in practice; enforce it in code or state the cap exactly (#1077, #1293).
- Was it run on the other harnesses and models, not just the default (#1037, #1210)? A prompt or agent change with only unit tests and snapshots has no evidence it changes agent behavior; ask for a real run or a telemetry query that would show it.

## necessity

- Tests do not pin copy. A regex on prose, or a snapshot plus a regex on the same text, breaks on every wording edit (#1349 "let's not pin the copy in the test").
- Test comments are one line; the test name carries intent.
