import assert from "node:assert/strict";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

function writePayload(fileName, content) {
  return { tool_name: "Write", tool_input: { file_path: `/nonexistent/${fileName}`, content } };
}

function decisionOf(payload, agentArguments = []) {
  const hookProcess = runHook("block-suppressions.mjs", payload, {}, process.cwd(), agentArguments);
  assert.equal(hookProcess.status, 0);
  if (!hookProcess.stdout) return { decision: "allow", reason: "" };
  const output = JSON.parse(hookProcess.stdout);
  if (output.decision) return output;
  return { decision: output.hookSpecificOutput.permissionDecision, reason: output.hookSpecificOutput.permissionDecisionReason };
}

test("net-new lint, type and test suppressions are denied in every language the comment scanner reads", () => {
  const silencedWrites = [
    ["parse.ts", "// @ts-ignore\nparse(input);"],
    ["parse.ts", "parse(input); // eslint-disable-line no-undef"],
    ["parse.js", "/* eslint-disable */\nparse(input);"],
    ["parse.test.ts", "it.only(\"parses\", () => {});"],
    ["parse.test.js", "xdescribe(\"parser\", () => {});"],
    ["parse.py", "value = parse(source)  # type: ignore[arg-type]"],
    ["parse.py", "import os  # noqa: F401"],
    ["test_parse.py", "@pytest.mark.skip\ndef test_parse():\n    pass"],
    ["parse.test.js", "test(\"parses\", { skip: true }, () => {});"],
    ["parse.test.ts", "it.skip.each([1])(\"parses\", () => {});"],
    ["deploy.sh", "# shellcheck disable=SC2086"],
  ];
  for (const [fileName, content] of silencedWrites) {
    const { decision, reason } = decisionOf(writePayload(fileName, content));
    assert.equal(decision, "deny", content);
    assert.match(reason, /Suppression guard/);
  }
});

test("suppressions inside strings, linked to an upstream issue, or already in the file pass", () => {
  const allowedWrites = [
    ["parse.ts", "const banner = \"// @ts-ignore\";"],
    ["parse.ts", "const template = `\n// eslint-disable\n`;"],
    ["parse.ts", "// @ts-expect-error https://github.com/acme/parser/issues/12 remove once 2.0 ships\nparse(input);"],
    ["model.py", "class Model:\n    def fit(self, features, labels):\n        pass"],
    ["parse.ts", "it.only(\"outside a test file\");"],
    ["parse.test.js", "test(\"parses\", { skip: false }, () => {});"],
    ["parse.md", "// @ts-ignore"],
  ];
  for (const [fileName, content] of allowedWrites) {
    assert.equal(decisionOf(writePayload(fileName, content)).decision, "allow", content);
  }
  const keptSuppression = {
    tool_name: "Edit",
    tool_input: { file_path: "/nonexistent/parse.ts", old_string: "parse(a); // @ts-ignore", new_string: "parse(b); // @ts-ignore" },
  };
  assert.equal(decisionOf(keptSuppression).decision, "allow");
  const secondDirectiveOnSameLine = { ...keptSuppression, tool_input: { ...keptSuppression.tool_input, new_string: "parse(b); // @ts-ignore eslint-disable-line" } };
  assert.equal(decisionOf(secondDirectiveOnSameLine).decision, "deny");
});

test("an agy write adding a suppression is denied in agy's reply shape", () => {
  const agyWrite = {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: { name: "write_file", args: { Path: "/nonexistent/parse.ts", Content: "// @ts-nocheck" } },
  };
  assert.equal(decisionOf(agyWrite, ["--agent=agy"]).decision, "deny");
});
