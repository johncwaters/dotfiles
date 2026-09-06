---
name: qa-swarm
description: The finder engine of the review ladder. Takes an already-pinned diff reference, runs a cheap router pass to rate danger and pick reviewer lanes, spawns the triggered lanes concurrently, and returns one converged STRUCTURED_FINDINGS block. It judges nothing, fixes nothing, and writes nothing. Invoked by code-review; not a standalone entry point.
---

# QA Swarm

Find, converge, return. Every lane emits the same structured format so the merge is mechanical.

## Contract with the caller

**Required input.** A `REVIEW_CMD` that resolves to an immutable diff (a tree object or a SHA range), the repo path, and 2 to 4 sentences of context the lanes cannot derive from the diff. Optionally a scope restriction (`-- <paths>`), and, from an earlier round: three separate lists — findings already settled as `NIT` or `AMBIGUOUS`, which lanes are told not to re-report; findings a writer claims to have fixed, which lanes are told to **check specifically** and to report again at whatever severity if the defect is still there, exempt from any reporting bar; and findings a writer declined, which lanes are told to report again if still present, likewise exempt from any bar — plus, when the caller sends round state, the round number, the caller-computed touched-file set, and the caller's reporting bar for this round. The three lists must never be merged: telling a lane to skip a finding somebody claims to have fixed is how an unverified fix becomes an approval, and a declined finding is neither settled nor claimed fixed, so folding it into either list buries a live defect the writer refused to touch.

**No `REVIEW_CMD`, no run.** Say so and stop. Pinning scope is `code-review`'s job, and computing a second pin here would let two layers review two different trees while believing they reviewed one.

**Guaranteed output.** One `STRUCTURED_FINDINGS` block plus one `OVERALL_SUMMARY`, and nothing after them.

**Never.** No verdict, no risk tier, no recommendation to merge or block. No file edits. No git writes. No PR comments. No looping. Those belong to layers above; emitting one here means two layers own the same decision.

## Step 1: Router pass

One cheap pass produces both a first-pass review and the delegation plan.

Route it per `~/.claude/ROUTING.md` rule 1: Codex `gpt-5.6-terra`, prompt written to a temp file, dispatched with `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-terra < <file>`. Codex quota exhausted (rate-limit or usage-cap error): step down to `gpt-5.6-luna`, then fall back to an `opus` agent; only the cost of the first pass changes. A model or CLI error is a stale row, not a cap: fall back to the `opus` agent and say the row is stale.

Ask it for:

1. **Danger rating** LOW / MEDIUM / HIGH, with the one fact that set it
2. **Complexity rating** LOW / MEDIUM / HIGH
3. **File classification**: which touched files are logic, security surface, structural, scale surface, config, test, or docs; scale surface means files where the diff iterates, recurses, queries, or accumulates over a collection whose size the context does not bound
4. **Delegation plan**: which lanes below should run, one clause of justification each
5. Its own findings, in the format below, tagged `router`

The router never spawns anything. It returns a plan; this skill decides and dispatches.

## Step 2: Delegate the lanes the router earned

| Lane tag | Target | Model | Triggers when |
|---|---|---|---|
| `code` | `code-reviewer` agent | opus | Always. Logic defects, correctness, contracts |
| `security` | `security-reviewer` agent | fable | Diff touches auth, input handling, crypto, payments, PII, secrets, infrastructure, or destructive operations |
| `structure` | `structure-reviewer` agent | opus | Diff is a refactor, establishes a new module or boundary, or moves responsibilities across existing ones |
| `necessity` | `necessity-reviewer` agent | opus | Diff introduces a net-new file, exported symbol, or doc section, and the context states a goal |
| `scale` | `scale-reviewer` agent | opus | Diff adds or changes a loop, recursion, query, batch, cache, or list endpoint whose input the context does not bound by fact |
| `external` | Codex CLI | `gpt-5.6-sol`, effort `high` | Danger or complexity is HIGH. An independent frontier read of the same diff |
| `tiebreak` | Grok CLI | default | Two lanes disagree on whether a specific finding is real. Runs in Step 3, never here |

**Claude-only machines.** A profile `CLAUDE.md` whose `<routing>` forbids external model CLIs (the work profile does, and its rule wins over `~/.claude/ROUTING.md`) forbids them here too. Sending a work diff to Codex or Grok is a confidentiality breach, not a routing preference. Substitute, and say in the summary that the Claude-only route was used:

| Lane | External route | Claude-only substitute |
|---|---|---|
| router | Codex `gpt-5.6-terra` | an `opus` agent, same prompt |
| `external` | Codex `gpt-5.6-sol` | a second `opus` agent over the same diff, prompted adversarially to refute the other lanes' findings rather than to repeat them |
| `tiebreak` | Grok | an `opus` agent given both positions and nothing else |

The substitutes are not a downgrade to be apologised for: what `external` buys is an independent read, and an adversarially-framed second pass buys that without leaving the vendor.

Every model id and CLI invocation above comes from the model table in `~/.claude/ROUTING.md`, which is the single source of truth and carries its own staleness stamp; re-read that row before dispatch rather than trusting the name here. The router and the `external` lane sit on different Codex tiers deliberately: the router is a cheap triage pass whose output is a plan, so it takes `terra`, while `external` is a frontier read of a diff already known to be dangerous, which is what ROUTING.md reserves `sol` at `high` effort for. An id that errors means the table moved: degrade per Step 3 and say the row is stale.

`code` always runs. Spawn every triggered lane in **one message, multiple calls**, so they run concurrently.

Every delegation prompt carries, per the delegation contract in `~/.claude/ROUTING.md`:

```
Scope: <changed-file set and REVIEW_CMD range for this lane>
Out of scope: Pre-existing issues outside that set; unchanged lines inside it are read, never anchored
Definition of done: <this lane's required structured output>
```

- the repo path and the exact `REVIEW_CMD` (plus any `-- <paths>` restriction for this lane)
- the caller's context, verbatim
- facts already verified live, and the settled `NIT` and `AMBIGUOUS` list, so the lane does not re-flag settled ground
- the claimed-fixed list as explicit regression checks, phrased as "confirm each of these is actually gone", never as "skip these", each reported again at its own severity when it is still present, exempt from any reporting bar the caller supplies, since a bar that silences a failed regression check turns a false `FIXED` into an approval
- the declined list, phrased as "report each of these again if it is still present", exempt from any reporting bar the caller supplies
- when the caller sends round state: the round number, its touched-file set, the instruction to focus on those files and on the regression and declined checks, and the caller's reporting bar relayed verbatim. The bar is the caller's rule to write and to arm; this skill states no severity threshold of its own, because a second copy here drifts from the owner's the first time the rule is tuned. The full `REVIEW_CMD` sweep stays regardless; only what is worth reporting on settled ground moves
- the router's danger and complexity ratings and which files it classified into this lane
- the ask: real defects with a concrete failure scenario, severity-tagged, with LOW as the minimum and never NIT, each anchored to a line the diff adds or removes, or to `general` when the defect is file-level
- the reviewer output format below

Hand over the command, never the diff text. Do not restate standing rules from AGENTS.md; every target already reads them.

## Reviewer output format

Every lane, and this skill itself, ends its response with:

```
STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM|LOW> | reviewer: <tag> | body: <the review comment text>
- file: ...

OVERALL_SUMMARY:
<one paragraph>
```

No findings:

```
STRUCTURED_FINDINGS:
(none)

OVERALL_SUMMARY:
<one paragraph>
```

**Tags** are `<lane>` or `<lane>/<category>`, the category being the finding's own lowercased, hyphenated kind: `security/idor`, `code/logic`, `structure/duplication`, `scale/quadratic`. Sub-tagging keeps each lane's taxonomy readable once findings converge; fall back to the flat lane tag when no category fits.

**`body`** is compact: what is wrong, the failure scenario, the fix, and `Confidence: low, <what would confirm it>` when the lane could not fully verify it. One finding per line, no newlines and no bare `|` inside a body.

**`side`** says which half of the diff `line` indexes: `RIGHT` for a line the diff adds or leaves in place, `LEFT` for a line the diff removes, in which case `line` is its number in the pre-change file. Default to `RIGHT`; a lane that reports a defect in deleted code must say `LEFT` explicitly. Nothing downstream can recover this from the finding alone, and a `LEFT` finding published as `RIGHT` lands on unrelated code. Omit the field entirely when `line` is `general`.

Lanes emit LOW at minimum and never `NIT`. Only code-review may use `NIT` as a disposition.

## Step 3: Converge

**Lane death is blocking, for the five agent lanes.** `code`, `security`, `structure`, `necessity`, or `scale` triggered and spawned, then erroring, returning empty, or producing no parseable `STRUCTURED_FINDINGS` block, is a failed run. Stop and tell the caller. Never return a partial block as if it were complete.

`router`, `external`, and `tiebreak` are exempt at every stage, before or after dispatch: they run on an external CLI with its own quota and none is ever the sole coverage for a concern. Their failure degrades, never blocks:

- Codex router quota exhausted: fall back down the tier ladder, then to an `opus` agent; a model or CLI error goes straight to the `opus` agent (Step 1). Every one of those failing means nobody rated danger or picked lanes, so run `code` and `security` and say the lane set was the no-router default. Running the always-on `code` lane alone would drop security coverage on a security-sensitive diff
- Codex `external` unavailable: run without it and say so in the summary. A concern the router routed there re-routes to `code` or `security`. If no lane can safely cover it, emit it as a HIGH finding naming the lane that was unavailable
- `tiebreak` unavailable: a contradiction is one defect claim plus one lane's verified-safe position, and only the claim is a finding, so there is no second finding to return. Emit the asserting lane's finding once, tagged `contested: <asserting lane> vs <disputing lane>`, with the disputing lane's reasoning in its body and `Confidence: low, tiebreak unavailable` at the end. That guarantees the caller triages it `AMBIGUOUS` rather than acting on a disputed claim

**Lane overflow.** Every agent lane caps itself at 10 findings and reports what it dropped as one sentence in its own summary. Read each lane's summary for that sentence and carry the lanes that capped into this skill's `OVERALL_SUMMARY`. Left as prose it dies here, and the caller's late-finding ratchet, which exists to give dropped overflow its first look, stays armed on a diff nobody finished sweeping.

**Deduplication.** First compute the changed-file set with `git diff --name-only` for the review range. Drop any finding whose `file` is outside that set and mention all such drops in at most one summary sentence. Then merge findings that name the same file within 5 lines of each other, or are plainly the same concern in different words. Merged findings carry the tag `convergent: <tag> + <tag>`. Convergence means independent lanes reached the same conclusion, so it promotes confidence: a merged finding counts as confirmed even when one lane marked it low-confidence. It does **not** by itself raise severity; keep the highest severity any lane assigned and name that lane in the body. A `necessity` finding never merges with another lane's finding, whatever the distance between them: both are kept under their own tags, so nothing is dropped, the other lane's finding keeps its own severity, and the CUT reaches triage on the `necessity` tag its rule keys on.

**Contradiction.** One lane asserts a defect and another explicitly verified it as safe: that is a `tiebreak` case, not a merge. Dispatch the Grok lane on those findings alone, with both positions in the prompt, and keep whichever finding its ruling supports.

## Step 4: Return

Emit the converged block and stop. No verdict line, no recommendation, no next step. The caller decides what any of it means.

The summary paragraph says: how many findings survived convergence, which lanes ran and which were skipped or degraded, the router's danger and complexity ratings, and the lanes that hit their own cap, written as the fixed phrase `truncated lanes: <comma-separated lane tags or none>`. Those are facts the caller needs and cannot recover. That one phrase is worded verbatim, always present, and `none` when nothing capped, because the caller parses it rather than reads it.

## Token discipline

- Floor is a router pass plus one `code` lane. Every extra lane is another full pass, and `security` runs on fable, the priciest tier.
- Never paste diff text into a prompt. Hand over `REVIEW_CMD` and let the lane run git itself.
- Diffs over roughly 2000 changed lines: tell each lane to prioritize by risk within its scope. Do not answer size by adding lanes.
- The router exists to keep lanes off work they do not need. A plan that delegates everything every time means the router prompt is wrong.
