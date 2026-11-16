import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

const effect = "useEffect(() => { document.title = name; }, [name]);";

function writePayload(extension, content) {
  return { tool_name: "Write", tool_input: { file_path: `/nonexistent/component${extension}`, content } };
}

const deniedScenarios = [
  { name: "a Write adds a useEffect call", payload: writePayload(".tsx", effect), sample: effect },
  { name: "a React-qualified useLayoutEffect counts", payload: writePayload(".jsx", "React.useLayoutEffect(() => measure(), []);"), sample: "React.useLayoutEffect" },
  { name: "a call after an unbalanced backtick or block opener still counts", payload: writePayload(".tsx", `const isFence = (line) => /^\`\`\`/.test(line);\nconst hint = <p>src/* only</p>;\n${effect}`), sample: effect },
  { name: "an aliased import counts", payload: writePayload(".ts", "import { useEffect as useMount } from 'react';"), sample: "useEffect as useMount" },
  {
    name: "an apply_patch adds a useEffect call",
    payload: {
      tool_name: "apply_patch",
      tool_input: { command: ["*** Begin Patch", "*** Add File: component.ts", `+${effect}`, "*** End Patch"].join("\n") },
    },
    sample: effect,
  },
];

for (const scenario of deniedScenarios) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-use-effect.mjs", scenario.payload);
    const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "deny");
    assert.ok(decision.permissionDecisionReason.includes(scenario.sample));
    assert.match(decision.permissionDecisionReason, /useSyncExternalStore/);
  });
}

const allowedWrites = [
  { name: "an import without a call passes", extension: ".ts", content: "import { useEffect } from 'react';" },
  { name: "useEffect in strings and comments passes", extension: ".tsx", content: "const label = 'useEffect(';\n// useEffect(\n/* useLayoutEffect( */" },
  { name: "a non-JS file passes", extension: ".md", content: effect },
];

for (const scenario of allowedWrites) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-use-effect.mjs", writePayload(scenario.extension, scenario.content));
    assert.equal(hookProcess.stdout, "");
    assert.equal(hookProcess.status, 0);
  });
}

test("an edit to a file with existing useEffect calls passes when it adds none", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-use-effect-"));
  const filePath = path.join(directory, "component.tsx");
  fs.writeFileSync(filePath, `${effect}\nconst greeting = "hi";\n`);
  const hookProcess = runHook("block-use-effect.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: 'const greeting = "hi";', new_string: 'const greeting = "hello";' },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(hookProcess.stdout, "");
});
