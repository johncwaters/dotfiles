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
  ];
  for (const splice of observedSplices) {
    const linted = lintDraft(splice);
    assert.equal(linted.exitCode, 1);
    assert.match(linted.stdout, new RegExp(`comma-splice: ${splice.replace(/[.]/g, "\\.")}`));
  }
  const labelledInterjectionTeaser = lintDraft("Agents not showing as agents: yeh, that one's real, and your own report (the voice inference one) shows why.");
  assert.deepEqual(labelledInterjectionTeaser.rules, ["teaser", "comma-splice"]);
  assert.match(labelledInterjectionTeaser.stdout, /teaser: delete the whole sentence/);
  const rewrite = lintDraft("Ty for the screenshots, and they helped a lot. If it moves to 13, that is the cause. We checked the API, the worker, and the DB. The log shows why the job failed: a stale token. Here's how to fix it: set X. However, the API returns 500 for that call. At 10:30, the worker, the API, and the DB restarted. Thanks!");
  assert.equal(rewrite.exitCode, 0, rewrite.stdout);
});

test("shared voice rules flag on every draft and long-form rules only with --longform", () => {
  const sharedDraft = "I just fixed it — basically.\nI hope this email finds you well.\nLet's delve into it.\n\nCheers,";
  assert.deepEqual(lintDraft(sharedDraft).rules, ["filler-word", "em-dash", "corporate-opener", "machine-tell", "corporate-closer"]);
  const longformDraft = "# Setup\n\nInstall it.\n\n## Why\n\nIt is not slow. It is careful and coming soon.\n\n- \u{1F680} Fast\n";
  assert.equal(lintDraft(longformDraft).exitCode, 0);
  assert.deepEqual(lintDraft(longformDraft, "--longform").rules, ["one-sentence-heading", "vague-quantity", "emoji-bullet"]);
});
