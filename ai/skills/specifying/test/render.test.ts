import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesignSpec } from "../lib/graph.ts";

function planChallengeStepDetector(): (planText: string) => number[] {
  const workflowSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../../workflows/plan-challenge.js"), "utf8");
  const metaExportDeclaration = /^export const meta =/;
  const orchestrationStart = workflowSource.indexOf("\nphase('Challenge')");
  assert.match(workflowSource, metaExportDeclaration, "plan-challenge.js must open with the meta export this test strips to evaluate it");
  assert.notEqual(orchestrationStart, -1, "plan-challenge.js must keep its function definitions above phase('Challenge')");
  const functionDefinitions = workflowSource.slice(0, orchestrationStart).replace(metaExportDeclaration, "const meta =");
  assert.match(functionDefinitions, /^function numberedStepsFrom\(/m, "plan-challenge.js must define numberedStepsFrom above phase('Challenge')");
  return Function("args", `${functionDefinitions}\nreturn numberedStepsFrom`)({});
}

test("plan renders active units in dependency order with exactly one challenge step per unit, and design renders each layer's code", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-render-"));
  try {
    const spec: DesignSpec = {
      status: "sliced",
      request: "Render the active plan",
      repoRoot,
      nodes: [
        { id: "G1", kind: "goal", text: "An actionable plan", risk: "medium", criteria: ["The plan renders."] },
        { id: "D1", kind: "decision", question: "Which format?", answer: "Numbered text", why: "The challenge workflow consumes it", source: "decided" },
        { id: "D2", kind: "decision", question: "Lifecycle?", answer: "None", why: "Rendering keeps no state", source: "decided", lifecycle: "none", isConstraint: true },
        { id: "Q1", kind: "openQuestion", question: "Which later extension?", settledBy: "Next request" },
        { id: "U2", kind: "unit", title: "Render the plan", reads: ["1. existing.ts"], changes: ["render.ts"], checks: [{ run: "node --test\n2. keep this command indented" }], serves: [1] },
        { id: "U3", kind: "unit", title: "Deferred extension", reads: [], changes: ["extension.ts"], checks: [{ run: "node --test" }], serves: [1] },
        { id: "I1", kind: "design", layer: "program", title: "Graph types", at: "graph.ts", code: "type Node = Goal | Unit;\n  function validate(spec: Spec): string[];" },
        { id: "U1", kind: "unit", title: "Add graph types", reads: [], changes: ["graph.ts"], checks: [{ run: "node --test" }], serves: [1] },
      ],
      edges: [
        { from: "U1", kind: "implements", to: "D1" },
        { from: "U1", kind: "implements", to: "I1" },
        { from: "U2", kind: "implements", to: "D1" },
        { from: "U3", kind: "implements", to: "D1" },
        { from: "U2", kind: "dependsOn", to: "U1" },
        { from: "U3", kind: "deferredBy", to: "Q1" },
      ],
    };
    fs.writeFileSync(path.join(repoRoot, "1. existing.ts"), "", "utf8");
    const specPath = path.join(repoRoot, "spec.json");
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const renderProcess = spawnSync("node", [path.resolve(import.meta.dirname, "../render.ts"), specPath, "plan"], { encoding: "utf8" });
    assert.equal(renderProcess.status, 0, renderProcess.stderr ?? "");
    const planText = renderProcess.stdout ?? "";
    assert.match(planText, /^1\. U1 Add graph types\n/m);
    assert.match(planText, /^2\. U2 Render the plan\n/m);
    assert.match(planText, /^   - depends on: U1$/m);
    assert.ok(!planText.includes("U3"));
    for (const planLine of planText.split("\n")) {
      if (planLine.length > 0) assert.match(planLine, /^(?:\d+\. U\d+ | {3}- )/);
    }
    assert.deepEqual(planChallengeStepDetector()(planText), [1, 2]);
    const designProcess = spawnSync("node", [path.resolve(import.meta.dirname, "../render.ts"), specPath, "design"], { encoding: "utf8" });
    assert.equal(designProcess.status, 0, designProcess.stderr ?? "");
    assert.equal(designProcess.stdout, "program\n  I1 Graph types (graph.ts)\n    type Node = Goal | Unit;\n      function validate(spec: Spec): string[];\n    built by U1\n");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
