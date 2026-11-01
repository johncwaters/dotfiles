import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, commitFile, makeRepo } from "../../committing/test/helpers.ts";

const ROUND_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "round.mjs");

function runRound(repository, ledgerRoot, argumentList, reviewText = "") {
  const processResult = spawnSync("node", [ROUND_SCRIPT, ...argumentList, "--repo", repository], {
    input: reviewText,
    encoding: "utf8",
    env: { ...process.env, CONVERGING_REVIEWS_DIR: ledgerRoot },
  });
  return { exitCode: processResult.status, report: JSON.parse(processResult.stdout) };
}

function workingTreeId(repository, scratchDirectory) {
  const indexCopy = path.join(scratchDirectory, "index");
  fs.copyFileSync(path.join(repository, ".git", "index"), indexCopy);
  const gitWithIndex = (argumentList) => spawnSync("git", argumentList, { cwd: repository, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: indexCopy } });
  gitWithIndex(["add", "-A"]);
  return gitWithIndex(["write-tree"]).stdout.trim();
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
  const firstTree = workingTreeId(repository, ledgerRoot);

  const started = runRound(repository, ledgerRoot, ["start", "--tree", firstTree]);
  assert.equal(started.report.outcome, "FRESH");

  const inLaneBody = "Off-by-one in the loop bound. Proof: a.txt:5 reads `changed 5`.";
  const upstreamBody = "Helper misreads the new value. Proof: a.txt:5 passes it in.";
  const swarmOutput = path.join(ledgerRoot, "swarm.output");
  const swarmRows = [findingRow(5, "MEDIUM", inLaneBody), findingRow(28, "HIGH", upstreamBody), findingRow(28, "MEDIUM", "Another defect on that line. Proof: a.txt:28.")];
  fs.writeFileSync(swarmOutput, JSON.stringify({ result: ["STRUCTURED_FINDINGS:", ...swarmRows.map((row) => row.replace(" | disposition: ACTIONABLE", "")), "", "OVERALL_SUMMARY:", "Summary."].join("\n") }));
  const firstRound = runRound(repository, ledgerRoot, ["classify", "--round", "1", "--base", started.report.base, "--head", firstTree, "--swarm-output", swarmOutput], reviewWith([
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
  const secondTree = workingTreeId(repository, ledgerRoot);
  const secondRound = runRound(repository, ledgerRoot, ["classify", "--round", "2", "--base", firstTree, "--head", secondTree], reviewWith([
    findingRow(6, "MEDIUM", inLaneBody, "convergent: code/logic + redteam/silent-failure"),
    findingRow(6, "HIGH", upstreamBody),
  ]));
  assert.equal(secondRound.exitCode, 21);
  assert.equal(secondRound.report.outcome, "STALLED");
  assert.equal(secondRound.report.droppedSettled, 1);
  assert.equal(runRound(repository, ledgerRoot, ["verify"]).exitCode, 24);
});

test("a clean delta round asks for a whole-diff sweep against the original base, whatever base the caller passes, and the severity bar tapers to HIGH after the first sweep", (context) => {
  const repository = makeRepo();
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round-ledger-"));
  context.after(() => cleanup(repository, ledgerRoot));
  commitFile(repository, "a.txt", linesWithChange([]));
  const pinChange = (changedLineNumbers) => {
    fs.writeFileSync(path.join(repository, "a.txt"), linesWithChange(changedLineNumbers));
    return workingTreeId(repository, ledgerRoot);
  };
  const classify = (round, base, head, rows) => runRound(repository, ledgerRoot, ["classify", "--round", String(round), "--base", base, "--head", head], reviewWith(rows));

  const firstTree = pinChange([5, 20]);
  const baseTree = runRound(repository, ledgerRoot, ["start", "--tree", firstTree]).report.base;
  const firstRound = classify(1, baseTree, firstTree, [findingRow(5, "MEDIUM", "Bound is off by one. Proof: a.txt:5.")]);
  assert.equal(firstRound.report.outcome, "CONTINUE");
  runRound(repository, ledgerRoot, ["record", "--fingerprint", firstRound.report.actionable[0].fingerprint, "--fix", "FIXED", "--round", "1"]);

  const secondTree = pinChange([5, 6, 20]);
  const deltaRound = classify(2, firstTree, secondTree, [findingRow(6, "MEDIUM", "Name could be clearer. Proof: a.txt:6.")]);
  assert.equal(deltaRound.exitCode, 12);
  assert.deepEqual([deltaRound.report.outcome, deltaRound.report.severityFloor, deltaRound.report.base, deltaRound.report.nextRound], ["SWEEP", "HIGH", baseTree, 3]);

  const firstSweep = classify(3, secondTree, secondTree, [findingRow(20, "MEDIUM", "Missed guard on the new branch. Proof: a.txt:20.")]);
  assert.deepEqual([firstSweep.report.outcome, firstSweep.report.kind, firstSweep.report.severityFloor], ["CONTINUE", "sweep", "MEDIUM"]);
  runRound(repository, ledgerRoot, ["record", "--fingerprint", firstSweep.report.actionable[0].fingerprint, "--fix", "FIXED", "--round", "3"]);

  const thirdTree = pinChange([5, 6, 20, 21]);
  assert.equal(classify(4, secondTree, thirdTree, []).report.outcome, "SWEEP");
  const secondSweep = classify(5, baseTree, thirdTree, [findingRow(21, "MEDIUM", "Comment wording drifts. Proof: a.txt:21.")]);
  assert.deepEqual([secondSweep.report.outcome, secondSweep.report.severityFloor], ["CLEAN", "HIGH"]);
  assert.equal(runRound(repository, ledgerRoot, ["verify"]).report.outcome, "VERIFIED");
});

test("a failing pre-push gate keeps a clean review from ending the round and its fix lets the loop move on", (context) => {
  const repository = makeRepo();
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round-ledger-"));
  context.after(() => cleanup(repository, ledgerRoot));
  commitFile(repository, "package.json", JSON.stringify({ scripts: { "check:fast": "node -e \"if (require('fs').existsSync('broken')) { console.log('not ok 1 - type token gate'); process.exit(1) }\"", test: "node -e \"process.exit(1)\"" } }));
  fs.writeFileSync(path.join(repository, ".git", "hooks", "pre-push"), "#!/bin/sh\nnpm run -s check:fast || exit 1\n");
  fs.writeFileSync(path.join(repository, "broken"), "");
  const firstTree = workingTreeId(repository, ledgerRoot);
  const baseTree = runRound(repository, ledgerRoot, ["start", "--tree", firstTree]).report.base;

  const failingRound = runRound(repository, ledgerRoot, ["classify", "--round", "1", "--base", baseTree, "--head", firstTree], reviewWith([]));
  assert.equal(failingRound.report.outcome, "CONTINUE");
  assert.deepEqual([failingRound.report.gate.name, failingRound.report.gate.source], ["check:fast", "pre-push hook"]);
  const [gateFinding] = failingRound.report.actionable;
  assert.equal(gateFinding.reviewer, "gate/check:fast");
  assert.match(gateFinding.body, /not ok 1 - type token gate/);
  runRound(repository, ledgerRoot, ["record", "--fingerprint", gateFinding.fingerprint, "--fix", "FIXED", "--round", "1"]);

  fs.rmSync(path.join(repository, "broken"));
  const fixedTree = workingTreeId(repository, ledgerRoot);
  const passingRound = runRound(repository, ledgerRoot, ["classify", "--round", "2", "--base", firstTree, "--head", fixedTree], reviewWith([]));
  assert.deepEqual([passingRound.report.outcome, passingRound.report.gate.exitCode], ["SWEEP", 0]);
});
