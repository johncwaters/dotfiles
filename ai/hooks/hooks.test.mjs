import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function runHook(scriptName, payload) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, scriptName)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function runGit(repository, argumentsList) {
  const processResult = spawnSync("git", argumentsList, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0, processResult.stderr);
  return (processResult.stdout ?? "").trim();
}

function makeRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "finding-scope-hook-"));
  runGit(repository, ["init", "-q"]);
  runGit(repository, ["config", "user.name", "Test User"]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "a.txt"), "one\n", "utf8");
  runGit(repository, ["add", "--", "a.txt"]);
  runGit(repository, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repository, "a.txt"), "two\n", "utf8");
  return repository;
}

function findingsFor(filePath) {
  return [
    "STRUCTURED_FINDINGS:",
    `- file: ${filePath} | line: 1 | side: RIGHT | severity: LOW | reviewer: code/logic | body: example`,
    "",
    "OVERALL_SUMMARY:",
    "Example summary.",
  ].join("\n");
}

test("spawn prompt missing scope markers is denied", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: { model: "opus", prompt: "Scope:\nai/hooks" },
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

test("finding scope warns only for files outside the diff", () => {
  const repository = makeRepository();
  try {
    const outOfScopeResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: { content: [{ type: "text", text: findingsFor("b.txt") }] },
    });
    assert.equal(outOfScopeResult.status, 0);
    const warning = JSON.parse(outOfScopeResult.stdout);
    assert.match(warning.hookSpecificOutput.additionalContext, /b\.txt/);
    assert.equal(warning.hookSpecificOutput.hookEventName, "PostToolUse");

    const inScopeResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Task",
      tool_response: findingsFor("a.txt"),
    });
    assert.equal(inScopeResult.status, 0);
    assert.equal(inScopeResult.stdout, "");

    fs.writeFileSync(path.join(repository, "new.txt"), "untracked\n", "utf8");
    const untrackedResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: findingsFor("new.txt"),
    });
    assert.equal(untrackedResult.status, 0);
    assert.equal(untrackedResult.stdout, "");
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope is silent without a structured findings block", () => {
  const processResult = runHook("check-finding-scope.mjs", {
    cwd: process.cwd(),
    tool_name: "Agent",
    tool_response: "No structured review output.",
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});
