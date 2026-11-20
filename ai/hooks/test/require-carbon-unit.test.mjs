import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

function stopDecision(lastAssistantMessage, extraPayload = {}) {
  const hookProcess = runHook("require-carbon-unit.mjs", { last_assistant_message: lastAssistantMessage, ...extraPayload });
  if (hookProcess.stdout === "") return { decision: "allow", reason: "" };
  return JSON.parse(hookProcess.stdout);
}

function transcriptOf(...userEntries) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "carbon-unit-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, userEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return transcriptPath;
}

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const stopFeedback = (reason) => ({ type: "user", isMeta: true, message: { role: "user", content: `Stop hook feedback:\n${reason}` } });
const ownFeedback = stopFeedback('The reply says "user" where <output_style> requires "carbon unit" or "carbon units".');

test("the hook blocks once per turn on its own feedback, not on another Stop hook's", () => {
  const reply = "Landed. The user can rerun dot.";
  const afterCommitGate = transcriptOf(prompt("ship it"), stopFeedback("This turn ends with uncommitted edits this session made and no /landing since: a.ts."));
  assert.equal(stopDecision(reply, { stop_hook_active: true, transcript_path: afterCommitGate }).decision, "block");
  const afterOwnBlock = transcriptOf(prompt("ship it"), ownFeedback);
  assert.equal(stopDecision(reply, { stop_hook_active: true, transcript_path: afterOwnBlock }).decision, "allow");
  const nextTurn = transcriptOf(prompt("ship it"), ownFeedback, prompt("and again"));
  assert.equal(stopDecision(reply, { transcript_path: nextTurn }).decision, "block");
});

test("a reply naming people in prose is blocked once with each word named", () => {
  const { decision, reason } = stopDecision("Done. The user can rerun it, and Developers see the People list.");
  assert.equal(decision, "block");
  assert.match(reason, /"user", "Developers", "People"/);
  assert.equal(stopDecision("The user can rerun it.", { stop_hook_active: true }).decision, "allow");
  assert.equal(stopDecision("The user can rerun it.", { agent_id: "agent-1" }).decision, "allow");
  assert.equal(stopDecision("Wrap the SQL in ``` before pasting. The user then reruns it.").decision, "block");
});

test("code, quotes, identifiers, and user-level terms pass", () => {
  const passingReplies = [
    "The carbon unit can rerun it.",
    "Renamed `user_id` in the `persons` table.",
    "```sql\nselect * from users;\n```\nDone.",
    "> the user said ship it\nShipped.",
    'The error reads "user not found".',
    "Set it in user-level settings; read user_id and user.name from https://example.com/users/1.",
  ];
  for (const reply of passingReplies) {
    assert.equal(stopDecision(reply).decision, "allow", reply);
  }
});
