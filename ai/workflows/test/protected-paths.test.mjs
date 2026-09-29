import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { protectedPaths } from "../../protected-paths.mjs";
import { runHook } from "../../hooks/test/harness.mjs";
import { workflowFunctionNamed } from "./qa-swarm-source.mjs";

const aiDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(aiDirectory);
const expectedClaudeRules = protectedPaths
  .filter((protectedPath) => protectedPath.scope === "both")
  .map((protectedPath) => `Read(${protectedPath.path}${protectedPath.kind === "directory" ? "/**" : ""})`);
const glimmervoidFileEntries = ["~/.glimmervoid/config.json*", "~/.glimmervoid/secrets.env"];
const wholeGlimmervoidOrTeamReviewPattern = /~\/\.glimmervoid(\/?\*{0,2}["')\\]|\/team-review-)/;
const expectedCodexProfile = `'permissions.qa_review={extends=":read-only", filesystem={${protectedPaths.map((protectedPath) => `"${protectedPath.path}"="deny"`).join(", ")}}}'`;

test("the protected paths have one scoped entry per personal credential path", () => {
  assert.equal(protectedPaths.length, new Set(protectedPaths.map((protectedPath) => protectedPath.path)).size);
  assert.deepEqual(protectedPaths.filter((protectedPath) => protectedPath.scope === "codex").map((protectedPath) => protectedPath.path), ["~/.codex/auth.json"]);
  assert.ok(protectedPaths.find((protectedPath) => protectedPath.path === "~/.codex/auth.json")?.reason);
  assert.ok(protectedPaths.every((protectedPath) => ["both", "codex"].includes(protectedPath.scope)));
  assert.ok(protectedPaths.every((protectedPath) => ["directory", "file"].includes(protectedPath.kind)));
  for (const glimmervoidFileEntry of glimmervoidFileEntries) {
    assert.deepEqual(protectedPaths.find((protectedPath) => protectedPath.path === glimmervoidFileEntry), { path: glimmervoidFileEntry, kind: "file", scope: "both" });
  }
  assert.ok(protectedPaths.every((protectedPath) => !protectedPath.path.startsWith("~/.glimmervoid") || glimmervoidFileEntries.includes(protectedPath.path)));
});

test("rendered Claude denies match the shared paths and scope Glimmervoid to its config and secrets files", () => {
  const renderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-"));
  const settingsPath = path.join(renderDirectory, "settings.json");
  try {
    const renderProcess = spawnSync("node", [
      path.join(aiDirectory, "render-settings.mjs"),
      path.join(aiDirectory, "settings.base.json"),
      path.join(repoRoot, "profiles/personal/settings.overlay.json"),
      settingsPath,
      renderDirectory,
    ], { encoding: "utf8" });
    assert.equal(renderProcess.status, 0, renderProcess.stderr);
    const renderedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const baseSettings = JSON.parse(fs.readFileSync(path.join(aiDirectory, "settings.base.json"), "utf8"));
    assert.deepEqual(baseSettings.permissions.deny.filter((rule) => rule.startsWith("Read(")), []);
    assert.deepEqual(renderedSettings.permissions.deny, [...baseSettings.permissions.deny, ...expectedClaudeRules]);
    assert.doesNotMatch(JSON.stringify(renderedSettings.permissions.deny), /\.codex\/auth\.json/);
    for (const glimmervoidFileEntry of glimmervoidFileEntries) {
      assert.ok(renderedSettings.permissions.deny.includes(`Read(${glimmervoidFileEntry})`), glimmervoidFileEntry);
    }
    assert.doesNotMatch(JSON.stringify(renderedSettings.permissions.deny), wholeGlimmervoidOrTeamReviewPattern);
  } finally {
    fs.rmSync(renderDirectory, { recursive: true, force: true });
  }
});

test("qa-swarm profile and gate sanctioned command match the shared paths", () => {
  const codexDispatchCommand = workflowFunctionNamed("codexDispatchCommand", { repoPath: "/repo" });
  const actualCommand = codexDispatchCommand("gpt-6.1-sol", "high", "/tmp/codex-dispatch-paths");
  const expectedCommand = `codex exec -c ${expectedCodexProfile} -c 'default_permissions="qa_review"' -C /repo -m gpt-6.1-sol -c model_reasoning_effort="high" < /tmp/codex-dispatch-paths.txt 2> /tmp/codex-dispatch-paths.err`;
  assert.equal(actualCommand, expectedCommand);
  for (const glimmervoidFileEntry of glimmervoidFileEntries) {
    assert.ok(actualCommand.includes(`"${glimmervoidFileEntry}"="deny"`), glimmervoidFileEntry);
  }
  assert.doesNotMatch(actualCommand, wholeGlimmervoidOrTeamReviewPattern);
  const dispatcherCall = (command) => ({
    agent_id: "agent-1",
    agent_type: "codex-dispatcher",
    tool_name: "Bash",
    tool_input: { command },
  });
  const acceptedDispatch = runHook("gate-codex-dispatch.mjs", dispatcherCall(expectedCommand));
  assert.equal(acceptedDispatch.status, 0, acceptedDispatch.stderr);
  assert.equal(acceptedDispatch.stdout, "");
  for (const protectedPath of protectedPaths) {
    const changedCommand = expectedCommand.replace(`"${protectedPath.path}"="deny", `, "").replace(`, "${protectedPath.path}"="deny"`, "");
    assert.notEqual(changedCommand, expectedCommand, protectedPath.path);
    const rejectedDispatch = runHook("gate-codex-dispatch.mjs", dispatcherCall(changedCommand));
    assert.equal(rejectedDispatch.status, 0, rejectedDispatch.stderr);
    assert.equal(JSON.parse(rejectedDispatch.stdout).hookSpecificOutput.permissionDecision, "deny", protectedPath.path);
  }
});
