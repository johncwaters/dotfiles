import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const lintDraftScript = new URL("../scripts/lint-draft.mjs", import.meta.url).pathname;

function lintDraft(draft, ...flags) {
  const run = spawnSync(process.execPath, [lintDraftScript, ...flags], { input: draft, encoding: "utf8" });
  const rules = run.stdout.split("\n").map((line) => line.match(/^\d+: ([a-z-]+): /)?.[1]).filter(Boolean);
  return { exitCode: run.status, stdout: run.stdout, rules };
}

test("comma splices from real support drafts fail and their joined rewrite passes", () => {
  const observedSplices = [
    "Ty for all the detail, the screenshots and check times help a lot.",
    "Ty for the screenshots, they helped a lot.",
    "Ty for checking those, that rules out a lot.",
    "With PostHog you see traces, you can also see costs.",
    "In review: the cache is stale, it needs a flush.",
    "On the funnel chart: yeah, that is a bug.",
    "On it, I will take a look.",
  ];
  for (const splice of observedSplices) {
    const linted = lintDraft(splice);
    assert.equal(linted.exitCode, 1);
    assert.match(linted.stdout, new RegExp(`comma-splice: ${splice.replace(/[.]/g, "\\.")}`));
  }
  const labelledInterjectionTeaser = lintDraft("Agents not showing as agents: yeh, that one's real, and your own report (the voice inference one) shows why.");
  assert.deepEqual(labelledInterjectionTeaser.rules, ["teaser", "comma-splice"]);
  assert.match(labelledInterjectionTeaser.stdout, /teaser: delete the whole sentence/);
  const rewrite = lintDraft("Ty for the screenshots, and they helped a lot. If it moves to 13, that is the cause. We checked the API, the worker, and the DB. The log shows why the job failed: a stale token. Here's how to fix it: set X. However, the API returns 500 for that call. At 10:30, the worker, the API, and the DB restarted. nit: right after the online evals chapter, this reads like the test came later. **nit:** right after the X chapter, this reads like a list. If the log says: worker restarted, the job lost its lease. In this conversation, the visitor changed their mind. To investigate, the engineers put request counts beside cost. Thanks!");
  assert.deepEqual(rewrite.rules, ["message-length"], rewrite.stdout);
});

test("shared voice rules flag on every draft and long-form rules only with --longform", () => {
  const sharedDraft = "I just fixed it — basically.\nI hope this email finds you well.\nLet's delve into it.\n\nCheers,";
  assert.deepEqual(lintDraft(sharedDraft).rules, ["filler-word", "em-dash", "corporate-opener", "machine-tell", "corporate-closer"]);
  const recordedKickers = [
    "The whole clip is rendered from one SVG page, and nobody drew a single frame by hand.",
    "When I changed the board, the agent didn't hear about it, and my coding agent kept building the old one.",
    "We checked the logs, and nothing was wrong.",
    "You flip the flag off, and nobody waits on a revert, ever.",
  ];
  for (const kicker of recordedKickers) {
    assert.deepEqual(lintDraft(kicker).rules, ["kicker"], kicker);
    assert.deepEqual(lintDraft(kicker, "--longform").rules, ["kicker"], kicker);
  }
  assert.match(lintDraft(recordedKickers[0]).stdout, /kicker: end the sentence at the fact/);
  const longformDraft = "# Setup\n\nInstall it.\n\n## Why\n\nIt is not slow. It is careful and coming soon.\n\n- \u{1F680} Fast\n";
  assert.equal(lintDraft(longformDraft).exitCode, 0);
  assert.deepEqual(lintDraft(longformDraft, "--longform").rules, ["one-sentence-heading", "vague-quantity", "emoji-bullet"]);
  const pocketGuideDraft = "---\nsubtitle: Understand AI token usage, model costs, and latency. Use PostHog AI Observability to investigate expensive conversations.\n---\n\nIt's kept for [30 days](/docs/ai-observability/data-retention). A missing capacity mustn’t count. Now they have a pretty good understanding of the trace.\n";
  assert.equal(lintDraft(pocketGuideDraft).exitCode, 0);
  assert.deepEqual(lintDraft(pocketGuideDraft, "--longform").rules, ["volatile-number", "british-form", "hedge", "mixed-apostrophes"]);
  const rejectedSlackReply = "The export broke because `EXPORT_BATCH_SIZE` is unset on that worker. Run `kubectl rollout restart deploy/export` and it should recover, though if the queue is still backed up after a few minutes it is worth checking the dead letter topic too, since retries pile up there when the batch size is missing.";
  assert.deepEqual(lintDraft(rejectedSlackReply).rules, ["message-length"]);
  assert.deepEqual(lintDraft(rejectedSlackReply, "--longform").rules, []);
  assert.equal(lintDraft("The export broke because the batch size is unset. Restarting the worker fixes it.").exitCode, 0);
  const hyphenAndPossessiveDraft = "It's covered by [90-day data retention](/docs/data-retention).\n\nThe 2024’s costs are below.\n";
  assert.deepEqual(lintDraft(hyphenAndPossessiveDraft, "--longform").rules, ["volatile-number", "mixed-apostrophes"]);
});
