import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesignSpec } from "../lib/graph.ts";

test("cut refuses the deferred example and renders its challenged tickets", () => {
  const skillText = fs.readFileSync(path.resolve(import.meta.dirname, "../SKILL.md"), "utf8");
  const example = skillText.match(/^```json\s*\n([\s\S]*?)^```/m)?.[1];
  assert.ok(example, "SKILL.md must include a fenced json design graph");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-cut-"));
  try {
    const spec = JSON.parse(example) as DesignSpec;
    spec.repoRoot = repoRoot;
    fs.mkdirSync(path.join(repoRoot, "src", "export"), { recursive: true });
    const specPath = path.join(repoRoot, "export.json");
    const intentPath = path.join(repoRoot, "export.intent.json");
    const scriptPath = path.resolve(import.meta.dirname, "../cut.ts");
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const refusedProcess = spawnSync("node", [scriptPath, specPath], { encoding: "utf8" });
    assert.equal(refusedProcess.status, 1, refusedProcess.stderr);
    const refusal = JSON.parse(refusedProcess.stdout);
    assert.equal(refusal.outcome, "REFUSED");
    assert.ok(refusal.errors.some((error: string) => error.includes("status") && error.includes("sliced")));
    assert.ok(refusal.errors.some((error: string) => error.includes("U2") && error.includes("Q1") && error.includes("Is price a column?")));
    assert.equal(fs.existsSync(intentPath), false);
    spec.nodes = spec.nodes.filter((node) => node.kind !== "openQuestion");
    spec.edges = spec.edges.filter((edge) => edge.kind !== "deferredBy");
    spec.status = "challenged";
    spec.challengeStamp = "CHALLENGE: 2 kept, 0 shrunk, 0 cut";
    spec.challengedUnitIds = ["U1", "U2"];
    spec.nodes.reverse();
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const cutProcess = spawnSync("node", [scriptPath, specPath], { encoding: "utf8" });
    assert.equal(cutProcess.status, 0, cutProcess.stderr || cutProcess.stdout);
    assert.deepEqual(JSON.parse(cutProcess.stdout), { outcome: "CUT", intentPath, tickets: 2 });
    const intentText = fs.readFileSync(intentPath, "utf8");
    const intent = JSON.parse(intentText);
    assert.equal(intentText, `${JSON.stringify(intent, null, 2)}\n`);
    assert.deepEqual(intent.tickets.map((ticket: { id: string }) => ticket.id), ["U1", "U2"]);
    assert.deepEqual(intent.tickets[1].dependsOn, ["U1"]);
    assert.match(intent.tickets[0].objective, /^Add the CSV writer\. Decisions: Which columns\? Name, set, quantity\. Context: In the export module\. \(src\/export\/index\.ts:14\) Read first: src\/export\//);
    assert.ok(intent.tickets.every((ticket: { criteria: string[] }) => !ticket.criteria.some((criterion) => criterion.startsWith("Add the"))));
    assert.match(intent.tickets[0].objective, /\nDesign:\nCSV writer \(src\/export\/csv\.ts\):\ntype CsvRow = [^\n]+;\nexport function writeDeckCsv\(/);
    for (const ticket of intent.tickets) {
      for (const scope of ticket.writeScopes) {
        assert.ok(intent.writeScopes.some((intentScope: string) => scope === intentScope || scope.startsWith(`${intentScope}/`)));
      }
    }
    function verifyTexts(value: unknown): void {
      if (typeof value === "string") {
        const [proseText] = value.split("\nDesign:\n");
        assert.equal(proseText, proseText.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim());
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(verifyTexts);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      Object.values(value).forEach(verifyTexts);
    }
    verifyTexts(intent);
    const repeatedProcess = spawnSync("node", [scriptPath, specPath], { encoding: "utf8" });
    assert.equal(repeatedProcess.status, 0, repeatedProcess.stderr || repeatedProcess.stdout);
    assert.equal(fs.readFileSync(intentPath, "utf8"), intentText);
    assert.equal(intent.reviewGate, "gating-reviews");
    fs.writeFileSync(specPath, JSON.stringify({ ...spec, reviewGate: "committing" }), "utf8");
    const badGateProcess = spawnSync("node", [scriptPath, specPath], { encoding: "utf8" });
    assert.equal(badGateProcess.status, 1);
    assert.match(badGateProcess.stdout, /spec\.reviewGate: use one of gating-reviews/);
    spec.status = "sliced";
    delete spec.challengeStamp;
    delete spec.challengedUnitIds;
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const staleProcess = spawnSync("node", [scriptPath, specPath], { encoding: "utf8" });
    assert.equal(staleProcess.status, 1, staleProcess.stderr);
    assert.equal(JSON.parse(staleProcess.stdout).outcome, "REFUSED");
    assert.equal(fs.existsSync(intentPath), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
