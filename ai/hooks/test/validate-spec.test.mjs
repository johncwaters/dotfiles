import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runHook } from "./harness.mjs";

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "validate-spec-"));
const repoRoot = path.join(temporaryHome, "repo");
const specPath = path.join(temporaryHome, ".claude", "specs", "repo", "graph.json");
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(path.dirname(specPath), { recursive: true });
after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));

function slicedSpec() {
  return {
    status: "sliced",
    request: "Enforce the design graph",
    repoRoot,
    nodes: [
      { id: "G1", kind: "goal", text: "Enforce the graph" },
      { id: "D1", kind: "decision", question: "Which format?", answer: "JSON", why: "Typed contracts", source: "decided" },
      { id: "U1", kind: "unit", title: "Add validation", reads: [], changes: ["graph.ts"], checks: [{ run: "node --test" }] },
    ],
    edges: [{ from: "U1", kind: "implements", to: "D1" }],
  };
}

function writeSpec(spec, filePath = specPath) {
  return runHook("validate-spec.mjs", { tool_name: "Write", tool_input: { file_path: filePath, content: JSON.stringify(spec) } }, { HOME: temporaryHome });
}

function assertAllowed(hookProcess) {
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  assert.equal(hookProcess.stdout, "");
  assert.equal(hookProcess.stderr, "");
}

function denialReason(hookProcess) {
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  assert.equal(hookProcess.stderr, "");
  const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  return decision.permissionDecisionReason;
}

test("valid sliced specs under HOME are allowed", () => {
  assertAllowed(writeSpec(slicedSpec()));
});

test("a sliced spec is refused until its units are ticket-ready", () => {
  const spec = slicedSpec();
  const goal = spec.nodes.find((node) => node.id === "G1");
  const unit = spec.nodes.find((node) => node.id === "U1");
  goal.risk = "urgent";
  goal.criteria = [];
  const goalReason = denialReason(writeSpec(spec));
  assert.match(goalReason, /Rule 1: node G1\.risk: set risk to low, medium, high, or critical/);
  assert.match(goalReason, /Rule 1: node G1\.criteria: supply an array of 1 to 12 non-empty strings/);
  goal.risk = "low";
  goal.criteria = ["The graph can be validated"];
  unit.serves = [1];
  unit.checks = [{ run: "node --test | tee log" }];
  unit.changes = ["src/*"];
  const unitReason = denialReason(writeSpec(spec));
  assert.match(unitReason, /Rule 14: node U1\.checks\[0\]\.run/);
  assert.match(unitReason, /Rule 15: node U1/);
  unit.checks = [{ run: "node --test\u0085" }];
  unit.changes = [" ../outside"];
  const disguisedInputReason = denialReason(writeSpec(spec));
  assert.match(disguisedInputReason, /Rule 6: node U1: replace path {2}\.\.\/outside with a relative path inside repoRoot/);
  assert.match(disguisedInputReason, /Rule 14: node U1\.checks\[0\]\.run/);
  unit.checks = [{ run: "node --test" }];
  unit.changes = ["shared"];
  spec.nodes.push(
    { id: "U2", kind: "unit", title: "Extend validation", reads: [], changes: ["shared/graph.ts"], checks: [{ run: "node --test" }] },
    { id: "U3", kind: "unit", title: "Connect validation", reads: [], changes: ["shared-sibling"], checks: [{ run: "node --test" }] },
  );
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U3", kind: "implements", to: "D1" });
  assert.equal(denialReason(writeSpec(spec)), "Rule 16: node U1: add a direct or transitive dependsOn path in either direction with U2 to order changes sharing shared/graph.ts");
  spec.nodes.find((node) => node.id === "U2").changes = ["shared\\graph.ts"];
  assert.equal(denialReason(writeSpec(spec)), "Rule 16: node U1: add a direct or transitive dependsOn path in either direction with U2 to order changes sharing shared/graph.ts");
  spec.edges.push({ from: "U1", kind: "dependsOn", to: "U3" }, { from: "U3", kind: "dependsOn", to: "U2" });
  assertAllowed(writeSpec(spec));
});

test("units without checks are denied by id, capped with the count the next write shows", () => {
  const spec = slicedSpec();
  spec.nodes.find((node) => node.id === "U1").checks = [];
  for (let unitNumber = 2; unitNumber <= 25; unitNumber++) {
    spec.nodes.push({ id: `U${unitNumber}`, kind: "unit", title: "Add a check", reads: [], changes: [`graph-${unitNumber}.ts`], checks: [] });
    spec.edges.push({ from: `U${unitNumber}`, kind: "implements", to: "D1" });
  }
  const reason = denialReason(writeSpec(spec));
  assert.match(reason, /Rule 10: node U1: add at least one check/);
  assert.match(reason, /\n5 more errors; they show on the next write/);
  assert.doesNotMatch(reason, /validate\.ts/);
});

test("an Edit whose old_string misses the file byte for byte is denied before the tool can fuzzy-match it", () => {
  const spec = slicedSpec();
  spec.request = "Enforce the carbon unit\u2019s design graph";
  const originalContent = JSON.stringify(spec);
  fs.writeFileSync(specPath, originalContent);
  spec.nodes.find((node) => node.id === "U1").checks = [];
  const toolInput = { file_path: specPath, old_string: originalContent.replace("\u2019", "'"), new_string: JSON.stringify(spec) };
  const reason = denialReason(runHook("validate-spec.mjs", { tool_name: "Edit", tool_input: toolInput }, { HOME: temporaryHome }));
  assert.match(reason, /old_string is absent.*Re-read the file and copy the exact text/);
});

test("a missing repoRoot or reads path is denied instead of measuring zero bytes", () => {
  const relocatedSpec = slicedSpec();
  relocatedSpec.repoRoot = path.join(temporaryHome, "removed-worktree");
  assert.match(denialReason(writeSpec(relocatedSpec)), /Rule 6: spec\.repoRoot: .*existing repository directory/);
  const spec = slicedSpec();
  spec.nodes.find((node) => node.id === "U1").reads = ["misspelled.ts"];
  assert.match(denialReason(writeSpec(spec)), /Rule 6: node U1: reads path misspelled\.ts is missing/);
  spec.nodes.push({ id: "U2", kind: "unit", title: "Create the file", reads: [], changes: ["misspelled.ts"], checks: [{ run: "node --test" }] });
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" });
  assertAllowed(writeSpec(spec));
});

test("a read directory holding a symlink that leaves the repo is allowed", () => {
  fs.mkdirSync(path.join(repoRoot, "linked"));
  fs.symlinkSync(os.tmpdir(), path.join(repoRoot, "linked", "outside"));
  const spec = slicedSpec();
  spec.nodes.find((node) => node.id === "U1").reads = ["linked"];
  assertAllowed(writeSpec(spec));
});

test("an unmeasurable entry is reported beside the other rule errors and skipped under a waiver", () => {
  fs.mkdirSync(path.join(repoRoot, "looped"));
  fs.symlinkSync("cycle", path.join(repoRoot, "looped", "cycle"));
  const spec = slicedSpec();
  const unit = spec.nodes.find((node) => node.id === "U1");
  unit.reads = ["looped"];
  unit.checks = [];
  const reason = denialReason(writeSpec(spec));
  assert.match(reason, /Rule 10: node U1: add at least one check/);
  assert.match(reason, /Rule 13: node U1: path \S*looped[/]cycle \(ELOOP\) cannot be measured/);
  unit.checks = [{ run: "node --test" }];
  unit.budgetWaiver = "The migration reads the whole directory";
  assertAllowed(writeSpec(spec));
});

test("a challenge stamp is denied once the units ready for work differ from the units it judged", () => {
  const spec = slicedSpec();
  spec.status = "challenged";
  spec.challengeStamp = "CHALLENGE: 1 kept, 0 shrunk, 0 cut";
  spec.challengedUnitIds = ["U1"];
  spec.nodes.push(
    { id: "Q1", kind: "openQuestion", question: "Which extension?", settledBy: "The next request" },
    { id: "U2", kind: "unit", title: "Deferred extension", reads: [], changes: ["extension.ts"], checks: [{ run: "node --test" }] },
  );
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U2", kind: "deferredBy", to: "Q1" });
  assertAllowed(writeSpec(spec));
  spec.edges = spec.edges.filter((edge) => edge.kind !== "deferredBy");
  assert.match(denialReason(writeSpec(spec)), /Rule 7: spec\.challengedUnitIds: .*U1, U2.*set status back.*remove challengeStamp/);
});

test("Edit and MultiEdit replay detect dependency cycles without changing disk", () => {
  const spec = slicedSpec();
  spec.nodes.push({ id: "U2", kind: "unit", title: "Render validation", reads: [], changes: ["render.ts"], checks: [{ run: "node --test" }] });
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U2", kind: "dependsOn", to: "U1" });
  const originalContent = JSON.stringify(spec);
  fs.writeFileSync(specPath, originalContent);
  const originalEdges = JSON.stringify(spec.edges);
  const cyclicEdges = JSON.stringify([...spec.edges, { from: "U1", kind: "dependsOn", to: "U2" }]);
  for (const toolName of ["Edit", "MultiEdit"]) {
    const edits = [{ old_string: originalEdges, new_string: cyclicEdges }];
    const toolInput = toolName === "Edit" ? { file_path: specPath, ...edits[0] } : { file_path: specPath, edits };
    const reason = denialReason(runHook("validate-spec.mjs", { tool_name: toolName, tool_input: toolInput }, { HOME: temporaryHome }));
    assert.match(reason, /Rule 4: edge U[12] dependsOn U[12].*cycle/);
    assert.equal(fs.readFileSync(specPath, "utf8"), originalContent);
  }
});

test("a real reading budget excess requires a waiver and deduplicates overlapping paths", () => {
  fs.mkdirSync(path.join(repoRoot, "large"));
  fs.writeFileSync(path.join(repoRoot, "large", "contract.txt"), "x".repeat(200001));
  const spec = slicedSpec();
  const unit = spec.nodes.find((node) => node.id === "U1");
  unit.reads = ["large", "large/contract.txt"];
  unit.changes = ["large/contract.txt"];
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*200001 bytes.*budgetWaiver/);
  unit.budgetWaiver = "The migration needs the complete existing contract";
  assertAllowed(writeSpec(spec));
});

test("unrelated writes and malformed or unreadable inputs allow silently", () => {
  assertAllowed(writeSpec({}, path.join(temporaryHome, "outside.json")));
  const unreadableSpecPath = path.join(temporaryHome, ".claude", "specs", "unreadable.json");
  fs.mkdirSync(unreadableSpecPath);
  assertAllowed(writeSpec({}, unreadableSpecPath));
  for (const payload of [null, false, [], {}, { tool_name: "Write", tool_input: null }, { tool_name: "Write", tool_input: { file_path: specPath, content: "{invalid" } }, { tool_name: "Edit", tool_input: { file_path: unreadableSpecPath, old_string: "old", new_string: "new" } }]) {
    assertAllowed(runHook("validate-spec.mjs", payload, { HOME: temporaryHome }));
  }
});
