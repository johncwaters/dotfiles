import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { agyStep, codexPatchCall, codexRolloutLines, makeRepository, removeAll, runHook } from "./harness.mjs";

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

function bashRun(command, output, isError = false) {
  const bashResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-Bash", content: output, is_error: isError }] } };
  return [toolUse("Bash", { command }), bashResult];
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

test("a turn ending with uncommitted session edits is blocked once with a pointer to /landing", () => {
  const { decision, reason } = stopDecision([prompt("fix it"), editDirtyFile]);
  assert.equal(decision, "block");
  assert.match(reason, /\/landing/);
  assert.match(reason, /a\.txt/);
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile], { stop_hook_active: true }).decision, "allow");
});

test("a /landing after the last edit, or edits that left no change, let the turn end", () => {
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...skillRun("landing")]).decision, "allow");
  const resumedCommit = bashRun('node "$HOME/.claude/skills/landing/preflight.ts" --paths a.txt', "ok");
  assert.equal(stopDecision([prompt("fix it"), ...skillRun("landing"), editDirtyFile, ...resumedCommit]).decision, "allow");
  const deniedPreflight = bashRun('node "$HOME/.claude/skills/landing/preflight.ts" --paths a.txt', "Permission to use Bash was denied", true);
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...deniedPreflight]).decision, "block");
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...bashRun("cat ~/.claude/skills/landing/preflight.ts", "source")]).decision, "block");
  assert.equal(stopDecision([prompt("fix it"), toolUse("Edit", { file_path: path.join(cleanRepository, "a.txt") })]).decision, "allow");
  assert.equal(stopDecision([prompt("note it"), toolUse("Write", { file_path: path.join(sandboxHome, "notes.md") })]).decision, "allow");
});

test("an edit after a /landing run blocks again", () => {
  assert.equal(stopDecision([prompt("fix it"), ...skillRun("landing"), prompt("one more"), editDirtyFile]).decision, "block");
});

test("a background launch that has not reported back lets the turn end until its notification arrives", () => {
  const [, backgroundTestsResult] = bashRun("npm test", "Command running in background with ID: b1. Output is being written to: /tmp/b1.output");
  const backgroundTests = [toolUse("Bash", { command: "npm test", run_in_background: true }), backgroundTestsResult];
  const notificationText = "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>tool-Bash</tool-use-id>\n<status>completed</status>\n</task-notification>";
  const midTurnNotification = { type: "attachment", attachment: { type: "queued_command", prompt: notificationText, commandMode: "task-notification" } };
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...backgroundTests]).decision, "allow");
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...backgroundTests, prompt(notificationText)]).decision, "block");
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...backgroundTests, midTurnNotification]).decision, "block");
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...bashRun("npm test", "# pass 12")]).decision, "block");
  const foregroundGrep = bashRun("grep -n BACKGROUND ai/hooks/require-commit-on-stop.mjs", "12:const BACKGROUND_LAUNCH_RESULT = /running in background|launched in background|Async agent launched/i;");
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile, ...foregroundGrep]).decision, "block");
});

test("Codex and agy turns ending with uncommitted session edits are blocked in their own reply shape", () => {
  const agentStop = (agent, entries, extra = {}) => {
    const transcriptPath = writeTranscript(entries);
    return runHook("require-commit-on-stop.mjs", { transcript_path: transcriptPath, transcriptPath, ...extra }, { HOME: sandboxHome }, process.cwd(), [`--agent=${agent}`]).stdout;
  };
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch";
  const turnContext = { type: "turn_context", payload: { cwd: dirtyRepository } };
  const codexEdit = [...codexRolloutLines("codex-tui", "fix it"), turnContext, codexPatchCall("c1", patch)];
  assert.equal(JSON.parse(agentStop("codex", codexEdit)).decision, "block");
  assert.equal(agentStop("codex", codexEdit, { stop_hook_active: true }), "");
  assert.equal(agentStop("codex", [...codexRolloutLines("codex_exec", "fix it"), turnContext, codexPatchCall("c1", patch)]), "");
  const agyEdit = [agyStep(0, "USER_INPUT", "<USER_REQUEST>\nfix it\n</USER_REQUEST>"), agyStep(1, "PLANNER_RESPONSE", "", [{ name: "edit_file", args: { Path: path.join(dirtyRepository, "a.txt"), Target: "one", Replacement: "two" } }])];
  assert.equal(JSON.parse(agentStop("agy", agyEdit)).decision, "continue");
  const agyCommand = [agyStep(2, "PLANNER_RESPONSE", "", [{ name: "run_command", args: { CommandLine: "git status" } }]), agyStep(3, "RUN_COMMAND", "clean")];
  assert.equal(JSON.parse(agentStop("agy", [...agyEdit, ...agyCommand])).decision, "continue");
  const variablePatchCall = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch))` } };
  assert.equal(JSON.parse(agentStop("codex", [...codexRolloutLines("codex-tui", "fix it"), turnContext, variablePatchCall])).decision, "block");
});

test("unattended sessions and unreadable transcripts are never blocked", () => {
  assert.equal(stopDecision([prompt("fix it"), editDirtyFile], {}, { CLAUDE_CODE_SESSION_ATTENDED: "0", HOME: sandboxHome }).decision, "allow");
  const missing = runHook("require-commit-on-stop.mjs", { hook_event_name: "Stop", transcript_path: path.join(sandboxHome, "missing.jsonl") }, ATTENDED);
  assert.equal(missing.stdout, "");
});
