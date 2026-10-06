import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

function decisionFor(payload) {
  const processResult = runHook("gate-posthog-exec-write.mjs", payload);
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") return "allow";
  return JSON.parse(processResult.stdout).hookSpecificOutput.permissionDecision;
}

function execCall(command) {
  return { tool_name: "mcp__posthog__exec", tool_input: { command } };
}

test("sensitive PostHog writes ask before running", () => {
  for (const command of [
    "call update-feature-flag {\"id\":1}",
    "call --json create-feature-flag {}",
    "call feature-flags-bulk-delete-create {}",
    "call insight-delete {\"id\":2}",
    "call notebooks-destroy {}",
    "call experiment-launch {}",
    "call experiment-ship-variant {}",
    "call experiment-reset {}",
    "call survey-launch {}",
    "call workflows-enable {}",
    "  call  Insight-Delete {}",
  ]) {
    assert.equal(decisionFor(execCall(command)), "ask", command);
  }
});

test("routine writes and reads run without a prompt", () => {
  for (const command of [
    "call insight-create {}",
    "call dashboard-update {}",
    "call experiment-pause {}",
    "call feature-flag-get-all {}",
    "call feature-flags-list {}",
    "call execute-sql {\"query\":\"select delete from events\"}",
    "tools",
    "search feature-flag-delete",
    "info delete-feature-flag",
  ]) {
    assert.equal(decisionFor(execCall(command)), "allow", command);
  }
});

test("sensitive writes through any MCP exec tool ask before running", () => {
  for (const toolName of ["mcp__posthog-local__exec", "mcp__plugin_posthog_posthog__exec", "mcp__claude_ai_PostHog__exec"]) {
    assert.equal(decisionFor({ tool_name: toolName, tool_input: { command: "call delete-feature-flag {}" } }), "ask", toolName);
  }
});

test("other tools pass untouched", () => {
  for (const call of [
    { tool_name: "Bash", tool_input: { command: "call delete-feature-flag" } },
    { tool_name: "mcp__posthog__query", tool_input: { command: "call delete-feature-flag {}" } },
    { tool_name: "mcp__posthog__exec_status", tool_input: { command: "call delete-feature-flag {}" } },
    { tool_name: "mcp__posthog__exec", tool_input: null },
  ]) {
    assert.equal(decisionFor(call), "allow", JSON.stringify(call));
  }
});

test("a malformed payload is allowed", () => {
  const processResult = spawnSync("node", [path.join(import.meta.dirname, "..", "gate-posthog-exec-write.mjs")], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});
