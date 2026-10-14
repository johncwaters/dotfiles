import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

test("rough sessions are recorded, reported on the next start, and omitted after review", () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-reminder-"));
  try {
    const transcriptPath = join(directory, "rough-session.jsonl");
    const ledgerPath = join(directory, "ledger.jsonl");
    const sessionId = "rough-session";
    const transcriptEntries = [
      { type: "user", message: { content: "Start the task" } },
      { type: "user", message: { content: "No, use the existing helper" } },
      { type: "user", message: { content: "Stop changing unrelated files" } },
      { type: "system", subtype: "compact_boundary" },
    ];
    writeFileSync(transcriptPath, transcriptEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const environment = { RETRO_LEDGER: ledgerPath };
    const endedSession = runHook("retro-reminder.mjs", {
      hook_event_name: "SessionEnd", session_id: sessionId, transcript_path: transcriptPath,
      cwd: directory, reason: "prompt_input_exit",
    }, environment);
    assert.equal(endedSession.status, 0);
    assert.equal(endedSession.stdout, "");
    assert.equal(endedSession.stderr, `retro: 3 incidents this session (correction 2, compaction 1). Review with /retro ${sessionId}\n`);
    const sessionEntry = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
    assert.equal(sessionEntry.sessionId, sessionId);
    assert.equal(sessionEntry.transcriptPath, transcriptPath);
    assert.equal(sessionEntry.repo, directory);
    assert.equal(sessionEntry.incidentCount, 3);
    assert.equal(sessionEntry.counts.correction, 2);
    assert.equal(sessionEntry.reviewed, false);
    const startPayload = { hook_event_name: "SessionStart", session_id: "next-session", cwd: directory };
    const startedSession = runHook("retro-reminder.mjs", startPayload, environment);
    assert.equal(startedSession.status, 0);
    assert.equal(startedSession.stderr, "");
    assert.match(startedSession.stdout, /Unreviewed rough sessions in this repo/);
    assert.match(startedSession.stdout, /`rough-session`  3 incidents  0h/);
    appendFileSync(ledgerPath, JSON.stringify({ ...sessionEntry, at: new Date().toISOString(), reviewed: true }) + "\n");
    const reviewedStart = runHook("retro-reminder.mjs", startPayload, environment);
    assert.equal(reviewedStart.status, 0);
    assert.equal(reviewedStart.stdout, "");
    assert.equal(reviewedStart.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed payloads and missing transcripts fail open silently", () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-reminder-"));
  try {
    const environment = { RETRO_LEDGER: join(directory, "ledger.jsonl") };
    for (const payload of [null, {
      hook_event_name: "SessionEnd", session_id: "missing-session",
      transcript_path: join(directory, "missing.jsonl"), cwd: directory, reason: "prompt_input_exit",
    }]) {
      const hookProcess = runHook("retro-reminder.mjs", payload, environment);
      assert.equal(hookProcess.status, 0);
      assert.equal(hookProcess.stdout, "");
      assert.equal(hookProcess.stderr, "");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
