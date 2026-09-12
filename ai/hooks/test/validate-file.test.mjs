import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { writeExecutable } from "../../skills/commit/test/helpers.ts";
import { removeAll, runHook } from "./harness.mjs";

const validatorHome = fs.mkdtempSync(path.join(os.tmpdir(), "validate-file-hook-"));
const validatorEnvironment = { HOME: validatorHome, BIOME_BIN: validatorHome };
after(() => removeAll(validatorHome));

function validateWrite(toolInput, environment = validatorEnvironment) {
  return runHook("validate-file.mjs", { tool_name: "Write", tool_input: toolInput }, environment);
}

function readDenialReason(hookProcess) {
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, "PreToolUse");
  assert.equal(decision.permissionDecision, "deny");
  return decision.permissionDecisionReason;
}

test("malformed payload shapes fail open silently", () => {
  for (const payload of [null, false, [], {}, { tool_input: null }]) {
    const hookProcess = runHook("validate-file.mjs", payload, validatorEnvironment);
    assert.equal(hookProcess.status, 0, hookProcess.stderr);
    assert.equal(hookProcess.stdout, "");
    assert.equal(hookProcess.stderr, "");
  }
});

test("strict JSON remains guarded when the syntax engine cannot start", () => {
  const validWriteProcess = validateWrite({ file_path: "a.json", content: '{"valid":true}' });
  assert.equal(validWriteProcess.status, 0, validWriteProcess.stderr);
  assert.equal(validWriteProcess.stdout, "");
  assert.match(readDenialReason(validateWrite({ file_path: "a.json", content: "{bad}" })), /invalid JSON/);
});

test("control characters are located before syntax validation", () => {
  const invalidContent = "first line\nsecond" + String.fromCharCode(0) + "line";
  const denialReason = readDenialReason(validateWrite({ file_path: "a.ts", content: invalidContent }));
  assert.match(denialReason, /line 2, column 7/);
  assert.match(denialReason, /NUL byte/);
});

test("ordinary text and allowed whitespace pass without a parser", () => {
  const hookProcess = validateWrite({ file_path: "a.txt", content: "hello\tworld\n\r\f" });
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  assert.equal(hookProcess.stdout, "");
});

test("Edit validates the resulting document without writing it", () => {
  const filePath = path.join(validatorHome, "edit.json");
  fs.writeFileSync(filePath, '{"count":1}');
  const hookProcess = runHook("validate-file.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "1", new_string: "invalid" },
  }, validatorEnvironment);
  assert.match(readDenialReason(hookProcess), /invalid JSON/);
  assert.equal(fs.readFileSync(filePath, "utf8"), '{"count":1}');
});

test("MultiEdit validates only after all edits have been replayed", () => {
  const filePath = path.join(validatorHome, "multi-edit.json");
  fs.writeFileSync(filePath, '{"first":1,"second":1}');
  const hookProcess = runHook("validate-file.mjs", {
    tool_name: "MultiEdit",
    tool_input: {
      file_path: filePath,
      edits: [
        { old_string: "1", new_string: "pending", replace_all: true },
        { old_string: "pending", new_string: "2" + String.fromCharCode(0), replace_all: true },
      ],
    },
  }, validatorEnvironment);
  assert.match(readDenialReason(hookProcess), /NUL byte/);
  assert.equal(fs.readFileSync(filePath, "utf8"), '{"first":1,"second":1}');
});

test("explicit Edit content and the filePath alias remain supported", () => {
  const filePath = path.join(validatorHome, "alias.json");
  fs.writeFileSync(filePath, '{"valid":true}');
  const hookProcess = runHook("validate-file.mjs", {
    tool_name: "Edit",
    tool_input: { filePath, content: "{bad}", old_string: "absent" },
  }, validatorEnvironment);
  assert.match(readDenialReason(hookProcess), /alias\.json/);
});

test("unreadable edit targets fail open", () => {
  const hookProcess = runHook("validate-file.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: validatorHome, old_string: "old", new_string: "new" },
  }, validatorEnvironment);
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  assert.equal(hookProcess.stdout, "");
});

test("instruction caps block growth at repo roots but permit shrinking and nested docs", () => {
  fs.mkdirSync(path.join(validatorHome, ".git"));
  const filePath = path.join(validatorHome, "AGENTS.md");
  const oversizedContent = "x".repeat(17000);
  assert.match(readDenialReason(validateWrite({ file_path: filePath, content: oversizedContent })), /size cap/);
  fs.writeFileSync(filePath, oversizedContent + "x");
  const shrinkingWriteProcess = validateWrite({ file_path: filePath, content: oversizedContent });
  assert.equal(shrinkingWriteProcess.status, 0, shrinkingWriteProcess.stderr);
  assert.equal(shrinkingWriteProcess.stdout, "");
  const nestedWriteProcess = validateWrite({
    file_path: path.join(validatorHome, "nested", "AGENTS.md"),
    content: oversizedContent,
  });
  assert.equal(nestedWriteProcess.status, 0, nestedWriteProcess.stderr);
  assert.equal(nestedWriteProcess.stdout, "");
});

test("a failed diagnostic harvest cannot turn a syntax denial into an allow", () => {
  const enginePath = path.join(validatorHome, "biome");
  writeExecutable(enginePath, `#!${process.execPath}\nprocess.exit(1);\n`);
  const denialReason = readDenialReason(validateWrite(
    { file_path: "a.ts", content: "const count = ;" },
    { ...validatorEnvironment, BIOME_BIN: enginePath },
  ));
  assert.match(denialReason, /invalid TS syntax/);
});
