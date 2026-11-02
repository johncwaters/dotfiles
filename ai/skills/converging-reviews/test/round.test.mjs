import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, commitFile, makeRepo } from "../../landing/test/helpers.ts";

const ROUND_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "round.mjs");

function runRound(repository, ledgerRoot, argumentList, reviewText = "") {
  const processResult = spawnSync("node", [ROUND_SCRIPT, ...argumentList, "--repo", repository], {
    input: reviewText,
    encoding: "utf8",
    env: { ...process.env, CONVERGING_REVIEWS_DIR: ledgerRoot, REVIEW_GATES_DIR: path.join(ledgerRoot, "review-gates") },
  });
  return { exitCode: processResult.status, report: JSON.parse(processResult.stdout) };
}

function reviewWith(findingRows) {
  return ["VERDICT: REQUEST CHANGES", "ACTIONABLE: 0", "TRUNCATED: none", "", "STRUCTURED_FINDINGS:", ...findingRows, "", "OVERALL_SUMMARY:", "Summary."].join("\n");
}

function findingRow(line, severity, body, reviewer = "code/logic") {
  return `- file: a.txt | line: ${line} | side: RIGHT | severity: ${severity} | reviewer: ${reviewer} | disposition: ACTIONABLE | body: ${body}`;
}

function linesWithChange(changedLineNumbers) {
  return Array.from({ length: 30 }, (_, index) => (changedLineNumbers.includes(index + 1) ? `changed ${index + 1}` : `line ${index + 1}`)).join("\n") + "\n";
}

test("a loop round takes swarm bodies verbatim, drops off-hunk and settled findings and stalls when a fixed finding returns under another reviewer", (context) => {
  const repository = makeRepo();
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round-ledger-"));
  context.after(() => cleanup(repository, ledgerRoot));
  commitFile(repository, "a.txt", linesWithChange([]));
  fs.writeFileSync(path.join(repository, "a.txt"), linesWithChange([5]));

  const started = runRound(repository, ledgerRoot, ["start"]);
  assert.equal(started.report.outcome, "FRESH");

  const inLaneBody = "Off-by-one in the loop bound. Proof: a.txt:5 reads `changed 5`.";
  const upstreamBody = "Helper misreads the new value. Proof: a.txt:5 passes it in.";
  const swarmOutput = path.join(ledgerRoot, "swarm.output");
  const swarmRows = [findingRow(5, "MEDIUM", inLaneBody), findingRow(28, "HIGH", upstreamBody), findingRow(28, "MEDIUM", "Another defect on that line. Proof: a.txt:28.")];
  fs.writeFileSync(swarmOutput, JSON.stringify({ result: ["STRUCTURED_FINDINGS:", ...swarmRows.map((row) => row.replace(" | disposition: ACTIONABLE", "")), "", "OVERALL_SUMMARY:", "Summary."].join("\n") }));
  const firstRound = runRound(repository, ledgerRoot, ["classify", "--round", "1", "--swarm-output", swarmOutput], reviewWith([
    findingRow(5, "MEDIUM", "Loop bound is off by one, paraphrased. Proof: a.txt:5."),
    findingRow(25, "MEDIUM", "Unrelated naming drift. Proof: line 25 reads `line 25`."),
    findingRow(28, "HIGH", upstreamBody),
  ]));
  assert.equal(firstRound.exitCode, 10);
  assert.equal(firstRound.report.outcome, "CONTINUE");
  assert.equal(firstRound.report.actionable.length, 2);
  assert.deepEqual(firstRound.report.droppedOffHunk, { "code/logic": 1 });
  assert.equal(firstRound.report.unmatchedBodies, 2);
  assert.equal(firstRound.report.actionable[0].body, inLaneBody);

  const [inLaneFinding, upstreamFinding] = firstRound.report.actionable;
  runRound(repository, ledgerRoot, ["record", "--fingerprint", inLaneFinding.fingerprint, "--fix", "FIXED", "--round", "1"]);
  runRound(repository, ledgerRoot, ["record", "--fingerprint", upstreamFinding.fingerprint, "--fix", "DECLINED", "--round", "1"]);

  fs.writeFileSync(path.join(repository, "a.txt"), linesWithChange([5, 6]));
  assert.equal(runRound(repository, ledgerRoot, ["next"]).report.base, started.report.head);
  const secondRound = runRound(repository, ledgerRoot, ["classify", "--round", "2"], reviewWith([
    findingRow(6, "MEDIUM", inLaneBody, "convergent: code/logic + redteam/silent-failure"),
    findingRow(6, "HIGH", upstreamBody),
  ]));
  assert.equal(secondRound.exitCode, 21);
  assert.equal(secondRound.report.outcome, "STALLED");
  assert.equal(secondRound.report.droppedSettled, 1);
  assert.equal(runRound(repository, ledgerRoot, ["stamp", "a.txt"]).report.outcome, "UNSTAMPED");
});

test("every actionable finding counts whatever its severity, next resumes an unreviewed round, and a clean delta round sweeps the whole diff from the original base", (context) => {
  const repository = makeRepo();
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round-ledger-"));
  context.after(() => cleanup(repository, ledgerRoot));
  commitFile(repository, "a.txt", linesWithChange([]));
  const changeLines = (changedLineNumbers) => fs.writeFileSync(path.join(repository, "a.txt"), linesWithChange(changedLineNumbers));
  const classify = (round, rows) => runRound(repository, ledgerRoot, ["classify", "--round", String(round)], reviewWith(rows));

  changeLines([5, 20]);
  const firstRoundPlan = runRound(repository, ledgerRoot, ["start"]).report;
  const firstRound = classify(1, [findingRow(5, "MEDIUM", "Bound is off by one. Proof: a.txt:5.")]);
  assert.equal(firstRound.report.outcome, "CONTINUE");
  runRound(repository, ledgerRoot, ["record", "--fingerprint", firstRound.report.actionable[0].fingerprint, "--fix", "FIXED", "--round", "1"]);

  changeLines([5, 6, 20]);
  const deltaRoundPlan = runRound(repository, ledgerRoot, ["next"]).report;
  assert.deepEqual(runRound(repository, ledgerRoot, ["next"]).report, deltaRoundPlan);
  assert.deepEqual([deltaRoundPlan.outcome, deltaRoundPlan.round, deltaRoundPlan.kind, deltaRoundPlan.base], ["REVIEW", 2, "delta", firstRoundPlan.head]);
  const deltaRound = classify(2, [findingRow(6, "LOW", "Fix introduced an unchecked null. Proof: a.txt:6.")]);
  assert.deepEqual([deltaRound.report.outcome, deltaRound.report.actionable.length, Object.hasOwn(deltaRound.report, "severityFloor")], ["CONTINUE", 1, false]);
  runRound(repository, ledgerRoot, ["record", "--fingerprint", deltaRound.report.actionable[0].fingerprint, "--fix", "FIXED", "--round", "2"]);

  changeLines([5, 6, 7, 20]);
  runRound(repository, ledgerRoot, ["next"]);
  assert.equal(classify(3, []).exitCode, 12);
  const sweepPlan = runRound(repository, ledgerRoot, ["next"]).report;
  assert.deepEqual([sweepPlan.round, sweepPlan.kind, sweepPlan.base], [4, "sweep", firstRoundPlan.base]);
  assert.equal(classify(4, []).report.outcome, "CLEAN");
  const cleanStamp = runRound(repository, ledgerRoot, ["stamp", "a.txt"]);
  assert.deepEqual([cleanStamp.exitCode, cleanStamp.report.outcome, cleanStamp.report.stamp.gate], [0, "STAMPED", "converging-reviews"]);
  changeLines([5, 6, 7, 20, 22]);
  assert.equal(runRound(repository, ledgerRoot, ["stamp", "a.txt"]).exitCode, 24);
});

test("a failing pre-push gate keeps a clean review from ending the round and its fix lets the loop move on", (context) => {
  const repository = makeRepo();
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round-ledger-"));
  context.after(() => cleanup(repository, ledgerRoot));
  commitFile(repository, "package.json", JSON.stringify({ scripts: { "check:fast": "node -e \"if (require('fs').existsSync('broken')) { console.log('not ok 1 - type token gate'); process.exit(1) }\"", test: "node -e \"process.exit(1)\"" } }));
  fs.writeFileSync(path.join(repository, ".git", "hooks", "pre-push"), "#!/bin/sh\nnpm run -s check:fast || exit 1\n");
  fs.writeFileSync(path.join(repository, "broken"), "");
  runRound(repository, ledgerRoot, ["start"]);

  const failingRound = runRound(repository, ledgerRoot, ["classify", "--round", "1"], reviewWith([]));
  assert.equal(failingRound.report.outcome, "CONTINUE");
  assert.deepEqual([failingRound.report.gate.name, failingRound.report.gate.source], ["check:fast", "pre-push hook"]);
  const [gateFinding] = failingRound.report.actionable;
  assert.equal(gateFinding.reviewer, "gate/check:fast");
  assert.match(gateFinding.body, /not ok 1 - type token gate/);
  runRound(repository, ledgerRoot, ["record", "--fingerprint", gateFinding.fingerprint, "--fix", "FIXED", "--round", "1"]);

  fs.rmSync(path.join(repository, "broken"));
  runRound(repository, ledgerRoot, ["next"]);
  const passingRound = runRound(repository, ledgerRoot, ["classify", "--round", "2"], reviewWith([]));
  assert.deepEqual([passingRound.report.outcome, passingRound.report.gate.exitCode], ["SWEEP", 0]);
});
