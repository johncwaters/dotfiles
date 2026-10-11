import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateGraph } from "../lib/graph.ts";
import type { DesignSpec } from "../lib/graph.ts";

test("the first JSON example in SKILL.md validates as a design graph", () => {
  const skillText = fs.readFileSync(path.resolve(import.meta.dirname, "../SKILL.md"), "utf8");
  const example = skillText.match(/^```json\s*\n([\s\S]*?)^```/m)?.[1];
  assert.ok(example, "SKILL.md must include a fenced json design graph");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-doc-"));
  try {
    const spec = JSON.parse(example ?? "") as DesignSpec;
    spec.repoRoot = repoRoot;
    fs.mkdirSync(path.join(repoRoot, "src", "export"), { recursive: true });
    assert.deepEqual(validateGraph(spec), []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
