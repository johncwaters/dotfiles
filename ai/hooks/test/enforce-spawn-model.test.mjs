import assert from "node:assert/strict";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

test("spawn prompt missing scope markers and a model is denied once for both", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: { prompt: "Scope:\nai/hooks" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Out of scope:/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Definition of done:/);
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /Scope:\nOut of scope:\nDefinition of done:/,
  );
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explicit model pin/);
});

test("fork spawn without scope markers is allowed", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: { subagent_type: "fork", prompt: "Inherited conversation." },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("spawn prompt with every scope marker is allowed", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Task",
    tool_input: {
      model: "opus",
      prompt: "## scope:\nai/hooks\n### OUT OF SCOPE:\nai/agents\nDefinition of done:\nTests pass.",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("spawn prompt with scope markers still requires a model", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: {
      prompt: "Scope:\nai/hooks\nOut of scope:\nai/agents\nDefinition of done:\nTests pass.",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explicit model pin/);
});

test("an agy invoke_subagent is held to the scope markers but not to a model pin", () => {
  const agySpawn = (prompt) => runHook("enforce-spawn-model.mjs", {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: { name: "invoke_subagent", args: { Prompt: prompt, Role: "Lister", TypeName: "self" } },
  }, {}, process.cwd(), ["--agent=agy"]);
  const deniedProcess = agySpawn("Run ls.");
  const decision = JSON.parse(deniedProcess.stdout);
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /missing required scope markers/);
  const allowedProcess = agySpawn("Scope:\nls\nOut of scope:\nedits\nDefinition of done:\nnames listed.");
  assert.equal(allowedProcess.stdout, "");
});

test("a Codex spawn_agent carrying its task in items is held to the scope markers", () => {
  const hookProcess = runHook("enforce-spawn-model.mjs", {
    tool_name: "spawn_agent",
    tool_input: { items: [{ type: "text", text: "Run ls." }] },
  }, {}, process.cwd(), ["--agent=codex"]);
  assert.match(JSON.parse(hookProcess.stdout).hookSpecificOutput.permissionDecisionReason, /missing required scope markers/);
});
