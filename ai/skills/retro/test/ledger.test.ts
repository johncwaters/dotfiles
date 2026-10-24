import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lessonsReadyToPropose, readRetroLedger, recordSession, replaceSessionSightings } from "../lib/ledger.ts";
import type { SightingEntry } from "../lib/ledger.ts";
import type { RetroReport, RetroRun } from "../lib/report.ts";

function withLedger(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "retro-ledger-"));
  const previousPath = process.env.RETRO_LEDGER;
  process.env.RETRO_LEDGER = join(directory, "ledger.jsonl");
  try {
    run(directory);
  } finally {
    if (previousPath === undefined) delete process.env.RETRO_LEDGER;
    if (previousPath !== undefined) process.env.RETRO_LEDGER = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}
function sighting(sessionId: string, lessonKey = "bash-stash-denied", explicit = false): SightingEntry {
  return { v: 1, kind: "sighting", at: "2026-10-14T12:00:00Z", sessionId, lessonKey,
    summary: "Respect the stash restriction", incidentKinds: ["permission-denial"], lines: [4], explicit };
}
function report(): RetroReport {
  return { v: 1, generatedAt: "2026-10-14T12:00:00Z", sessionIds: ["session-one"], outcome: "proposals",
    proposals: [{ id: "proposal-one", lessonKey: "bash-stash-denied", target: "ai/hooks/guard.mjs", changeKind: "hook",
      summary: "Respect the stash restriction", incidents: [{ sessionId: "session-one", line: 4, kind: "permission-denial" }] }], reported: [] };
}
function runCli(script: string, argumentsList: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "..", script), ...argumentsList], { encoding: "utf8", timeout: 5000 });
}

test("lessons become ready across distinct sessions or from one explicit sighting", () => withLedger(() => {
  ok(replaceSessionSightings("session-one", [sighting("session-one")]));
  equal(lessonsReadyToPropose(readRetroLedger().sightings).size, 0);
  ok(replaceSessionSightings("session-two", [sighting("session-two")]));
  deepEqual(lessonsReadyToPropose(readRetroLedger().sightings).get("bash-stash-denied")?.map((entry) => entry.sessionId), ["session-one", "session-two"]);
  ok(replaceSessionSightings("session-three", [sighting("session-three", "explicit-lesson", true)]));
  equal(lessonsReadyToPropose(readRetroLedger().sightings).get("explicit-lesson")?.length, 1);
}));

test("replacing a session's sightings is idempotent and preserves foreign and garbage lines", () => withLedger(() => {
  const ledgerPath = process.env.RETRO_LEDGER as string;
  ok(replaceSessionSightings("session-one", [sighting("session-one")]));
  ok(replaceSessionSightings("session-two", [sighting("session-two")]));
  const foreignLines = '  {"v":2,"kind":"foreign"}  \nnot json\n';
  appendFileSync(ledgerPath, foreignLines);
  ok(replaceSessionSightings("session-one", [sighting("session-one")]));
  ok(replaceSessionSightings("session-one", [sighting("session-one")]));
  equal(readRetroLedger().sightings.length, 2);
  equal(readRetroLedger().sightings.filter((entry) => entry.sessionId === "session-one").length, 1);
  ok(readFileSync(ledgerPath, "utf8").includes(foreignLines));
}));

test("validate-report CLI accepts a valid report and rejects six proposals", () => withLedger((directory) => {
  const reportPath = join(directory, "report.json");
  const validReport = report();
  writeFileSync(reportPath, JSON.stringify(validReport));
  const validProcess = runCli("validate-report.ts", [reportPath]);
  equal(validProcess.status, 0, validProcess.stdout + validProcess.stderr);
  equal(JSON.parse(validProcess.stdout).outcome, "VALID");
  const proposal = validReport.proposals[0];
  ok(proposal);
  validReport.proposals = Array.from({ length: 6 }, (_, index) => ({ ...proposal, id: `proposal-${index}` }));
  writeFileSync(reportPath, JSON.stringify(validReport));
  const invalidProcess = runCli("validate-report.ts", [reportPath]);
  equal(invalidProcess.status, 1, invalidProcess.stdout + invalidProcess.stderr);
  ok(JSON.parse(invalidProcess.stdout).errors.some((error: string) => error.startsWith("proposals:")));
}));

test("record-run and show persist pending proposals and reviewed sessions without rerun duplicates", () => withLedger((directory) => {
  const session = { sessionId: "session-one", transcriptPath: "/transcripts/session-one.jsonl", repo: "/repo", incidentCount: 1, counts: { "permission-denial": 1 } };
  ok(recordSession({ ...session, v: 1, kind: "session", at: "2026-10-13T12:00:00Z", reviewed: false }));
  equal(JSON.parse(runCli("ledger.ts", ["show", "--repo", "/repo"]).stdout).unreviewedSessions.length, 1);
  const { v, kind, at, sessionId, ...sightingInput } = sighting("session-one", "bash-stash-denied", true);
  const run: RetroRun = { report: report(), sightings: { "session-one": [sightingInput] }, sessions: [session] };
  const runPath = join(directory, "run.json");
  writeFileSync(runPath, JSON.stringify(run));
  for (let index = 0; index < 2; index += 1) {
    const recordProcess = runCli("ledger.ts", ["record-run", runPath, "--ledger", process.env.RETRO_LEDGER as string]);
    equal(recordProcess.status, 0, recordProcess.stdout + recordProcess.stderr);
    equal(JSON.parse(recordProcess.stdout).recorded.proposals, index === 0 ? 1 : 0);
    const showProcess = runCli("ledger.ts", ["show", "--repo", "/repo"]);
    equal(showProcess.status, 0, showProcess.stdout + showProcess.stderr);
    const shown = JSON.parse(showProcess.stdout);
    equal(shown.pendingProposals.length, 1);
    equal(shown.pendingProposals[0].id, "proposal-one");
    deepEqual(shown.unreviewedSessions, []);
    deepEqual(shown.knownLessonKeys, ["bash-stash-denied"]);
    equal(shown.readyLessons.length, 1);
  }
  const ledger = readRetroLedger();
  equal(ledger.sightings.length, 1);
  equal(ledger.proposals.length, 1);
  equal(ledger.sessions[0]?.reviewed, true);
  equal(readFileSync(process.env.RETRO_LEDGER as string, "utf8").split("\n").filter((line) => line && JSON.parse(line).kind === "proposal").length, 1);
}));
