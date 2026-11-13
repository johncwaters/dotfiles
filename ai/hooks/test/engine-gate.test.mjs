import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { removeAll, runHook } from "./harness.mjs";

const transcriptsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-gate-"));

after(() => removeAll(transcriptsDirectory));

function toolUse(id, name, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id, content, isError = false) {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
}

function skillRun(id, skillName) {
  return [toolUse(id, "Skill", { skill: skillName }), toolResult(id, `Launching skill: ${skillName}`)];
}

function stopDecision(entries, extra = {}) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(transcriptsDirectory, "t-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  const processResult = runHook("engine-gate.mjs", { hook_event_name: "Stop", transcript_path: transcriptPath, ...extra });
  assert.equal(processResult.status, 0, processResult.stderr);
  if (processResult.stdout === "") return { decision: "allow", reason: "" };
  return JSON.parse(processResult.stdout);
}

const handReview = [...skillRun("s1", "reviewing-prs"), toolUse("b1", "Bash", { command: "git diff a..b" }), toolResult("b1", "diff")];
const swarmLaunch = [toolUse("w1", "Workflow", { name: "qa-swarm", args: {} }), toolResult("w1", "Workflow launched in background")];

test("a reviewing-prs run that stops before the engine launches is sent back once, a refused launch counting as none, and a launched engine or malformed payload lets it stop", () => {
  const { decision, reason } = stopDecision(handReview);
  assert.equal(decision, "block");
  assert.match(reason, /\/reviewing-code/);
  assert.equal(stopDecision(handReview, { stop_hook_active: true }).decision, "allow");
  assert.equal(stopDecision([...handReview, ...skillRun("s2", "reviewing-code"), ...swarmLaunch]).decision, "allow");
  assert.equal(stopDecision([...handReview, toolUse("a1", "Agent", { subagent_type: "qa-code-reviewer", prompt: "x" }), toolResult("a1", "Async agent launched")]).decision, "allow");
  const deniedByPath = [toolUse("w2", "Workflow", { scriptPath: "/x/.claude/workflows/qa-swarm.js" }), toolResult("w2", "Permission to use Workflow has been denied.", true)];
  assert.equal(stopDecision([...handReview, ...deniedByPath]).decision, "block");
  assert.equal(stopDecision([...handReview, toolUse("w3", "Workflow", { name: "qa-swarm" }), toolResult("w3", "Permission to use Workflow has been denied.", true)]).decision, "block");
  assert.equal(stopDecision([...swarmLaunch, ...handReview]).decision, "block");
  assert.equal(runHook("engine-gate.mjs", "not json").status, 0);
  assert.equal(stopDecision([toolUse("b2", "Bash", { command: "ls" })]).decision, "allow");
});
