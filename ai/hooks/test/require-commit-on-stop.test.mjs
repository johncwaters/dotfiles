import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { makeRepository, removeAll, runHook } from "./harness.mjs";

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "require-commit-home-"));
const dirtyRepository = makeRepository("one\n", "two\n");
const cleanRepository = makeRepository("same\n", "same\n");
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1", HOME: sandboxHome };

after(() => removeAll(sandboxHome, dirtyRepository, cleanRepository));

function prompt(text) {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUse(name, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${name}`, name, input }] } };
}

function skillRun(skillName) {
  const launchResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-Skill", content: `Launching skill: ${skillName}` }] } };
  return [toolUse("Skill", { skill: skillName }), launchResult];
}

function writeTranscript(entries) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(sandboxHome, "transcript-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return transcriptPath;
}

function stopDecision(entries, extra = {}, env = ATTENDED) {
  const processResult = runHook("require-commit-on-stop.mjs", { hook_event_name: "Stop", transcript_path: writeTranscript(entries), ...extra }, env);
  assert.equal(processResult.status, 0, processResult.stderr);
  if (processResult.stdout === "") return { decision: "allow", reason: "" };
  return JSON.parse(processResult.stdout);
}

const editDirtyFile = toolUse("Edit", { file_path: path.join(dirtyRepository, "a.txt") });

test("a turn ending with uncommitted session edits is blocked once with a pointer to /commit", () => {
  const { decision, reason } = stopDecision([prompt("fix it"), editDirtyFile]);
  assert.equal(decision, "block");
  assert.match(reason, /\/commit/);
  assert.match(reason, /a\.txt/);
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile], { stop_hook_active: true }).decision, "allow");
});

test("a /commit after the last edit, or edits that left no change, let the turn end", () => {
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...skillRun("commit")]).decision, "allow");
  assert.equal(stopDecision([prompt("fix it"), toolUse("Edit", { file_path: path.join(cleanRepository, "a.txt") })]).decision, "allow");
  assert.equal(stopDecision([prompt("note it"), toolUse("Write", { file_path: path.join(sandboxHome, "notes.md") })]).decision, "allow");
});

test("an edit after a /commit run blocks again", () => {
  assert.equal(stopDecision([prompt("fix it"), ...skillRun("commit"), prompt("one more"), editDirtyFile]).decision, "block");
});

test("unattended sessions and unreadable transcripts are never blocked", () => {
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile], {}, { CLAUDE_CODE_SESSION_ATTENDED: "0", HOME: sandboxHome }).decision, "allow");
  const missing = runHook("require-commit-on-stop.mjs", { hook_event_name: "Stop", transcript_path: path.join(sandboxHome, "missing.jsonl") }, ATTENDED);
  assert.equal(missing.stdout, "");
});
