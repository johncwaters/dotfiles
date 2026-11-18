import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

const sleep = "await new Promise((resolve) => setTimeout(resolve, 50));";
const assertion = "assert.equal(runCount, 1);";

function writePayload(filePath, content) {
  return { tool_name: "Write", tool_input: { file_path: filePath, content } };
}

const deniedScenarios = [
  { name: "a Write adds a sleep then an assertion to a test file", payload: writePayload("/nonexistent/tests/flow.test.ts", `${sleep}\n${assertion}`), sample: sleep },
  { name: "a timers/promises sleep on a named constant before expect counts", payload: writePayload("/nonexistent/src/flow.spec.tsx", "await setTimeout(SETTLE_MS);\n\nexpect(spy).toHaveBeenCalled();"), sample: "await setTimeout(SETTLE_MS);" },
  { name: "awaiting a local fixed-sleep helper before an assertion counts", payload: writePayload("/nonexistent/tests/usage.test.ts", `const settle = () => new Promise((resolve) => setTimeout(resolve, 20));\nawait settle();\n${assertion}`), sample: "await settle();" },
  {
    name: "an apply_patch adds a sleep then an assertion",
    payload: {
      tool_name: "apply_patch",
      tool_input: { command: ["*** Begin Patch", "*** Add File: test/flow.test.mjs", `+${sleep}`, `+${assertion}`, "*** End Patch"].join("\n") },
    },
    sample: sleep,
  },
];

for (const scenario of deniedScenarios) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-fixed-sleep.mjs", scenario.payload);
    const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "deny");
    assert.ok(decision.permissionDecisionReason.includes(scenario.sample));
    assert.match(decision.permissionDecisionReason, /await the operation itself or a signal it emits/);
  });
}

const allowedWrites = [
  { name: "a sleep inside a while poll loop passes", filePath: "/nonexistent/tests/poll.test.ts", content: `while (!isReady() && Date.now() < deadline) {\n  ${sleep}\n}\nassert.ok(isReady());` },
  { name: "a one-line for poll loop passes", filePath: "/nonexistent/tests/poll.test.ts", content: `for (let attempt = 0; attempt < 40 && !isReady(); attempt += 1) ${sleep}\nassert.ok(isReady());` },
  { name: "awaiting a polling helper before an assertion passes", filePath: "/nonexistent/tests/poll.test.ts", content: `const untilReady = async () => {\n  for (let attempt = 0; attempt < 40 && !isReady(); attempt += 1) ${sleep}\n};\nawait untilReady();\n${assertion}` },
  { name: "a sleep followed by an action passes", filePath: "/nonexistent/tests/act.test.ts", content: `${sleep}\nconnection.send(message);` },
  { name: "a sleep on a variable delay passes", filePath: "/nonexistent/tests/stub.test.ts", content: `await new Promise((resolve) => setTimeout(resolve, latencyMs));\n${assertion}` },
  { name: "a sleep in a non-test file passes", filePath: "/nonexistent/src/retry.ts", content: `${sleep}\n${assertion}` },
  { name: "sleep text inside strings and comments passes", filePath: "/nonexistent/tests/text.test.ts", content: `// ${sleep}\nconst example = '${sleep}';\n${assertion}` },
];

for (const scenario of allowedWrites) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-fixed-sleep.mjs", writePayload(scenario.filePath, scenario.content));
    assert.equal(hookProcess.stdout, "");
    assert.equal(hookProcess.status, 0);
  });
}

test("an edit to a test file with existing sleeps passes when it adds none", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-fixed-sleep-"));
  const filePath = path.join(directory, "flow.test.ts");
  fs.writeFileSync(filePath, `${sleep}\n${assertion}\nconst label = "hi";\n`);
  const hookProcess = runHook("block-fixed-sleep.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: 'const label = "hi";', new_string: 'const label = "hello";' },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(hookProcess.stdout, "");
  assert.equal(hookProcess.status, 0);
});
