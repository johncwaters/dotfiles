import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { commitFile, makeRepo } from "../../skills/landing/test/helpers.ts";
import { removeAll, runHook } from "./harness.mjs";

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "validate-spec-"));
const repoRoot = path.join(temporaryHome, "repo");
const specPath = path.join(temporaryHome, ".agents", "specs", "repo", "graph.json");
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(path.dirname(specPath), { recursive: true });
after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));

function slicedSpec() {
  return {
    status: "sliced",
    request: "Enforce the design graph",
    repoRoot,
    nodes: [
      { id: "G1", kind: "goal", text: "Enforce the graph", risk: "low", criteria: ["The graph validates."] },
      { id: "D1", kind: "decision", question: "Which format?", answer: "JSON", why: "Typed contracts", source: "decided" },
      { id: "U1", kind: "unit", title: "Add validation", reads: [], changes: ["graph.ts"], checks: [{ run: "node --test" }], serves: [1] },
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
  unit.title = "a".repeat(121);
  assert.match(denialReason(writeSpec(spec)), /Rule 1: node U1\.title: shorten the title to 120 characters \(has 121\)/);
  unit.title = "Add validation";
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
    { id: "U2", kind: "unit", title: "Extend validation", reads: [], changes: ["shared/graph.ts"], checks: [{ run: "node --test" }], serves: [1] },
    { id: "U3", kind: "unit", title: "Connect validation", reads: [], changes: ["shared-sibling"], checks: [{ run: "node --test" }], serves: [1] },
  );
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U3", kind: "implements", to: "D1" });
  assert.equal(denialReason(writeSpec(spec)), "Rule 16: node U1: add a direct or transitive dependsOn path in either direction with U2 to order changes sharing shared/graph.ts");
  spec.nodes.find((node) => node.id === "U2").changes = ["shared\\graph.ts"];
  assert.equal(denialReason(writeSpec(spec)), "Rule 16: node U1: add a direct or transitive dependsOn path in either direction with U2 to order changes sharing shared/graph.ts");
  spec.edges.push({ from: "U1", kind: "dependsOn", to: "U3" }, { from: "U3", kind: "dependsOn", to: "U2" });
  assertAllowed(writeSpec(spec));
});

test("a sliced spec changing a UI file is refused at any risk until a behavior design holds its HTML board mockups or a decision says it has none", () => {
  const mockupPage = path.join(temporaryHome, ".agents", "specs", "repo", "graph.mockups", "list.html");
  fs.mkdirSync(path.dirname(mockupPage), { recursive: true });
  fs.writeFileSync(mockupPage, "<!DOCTYPE html>");
  fs.mkdirSync(path.join(repoRoot, "views"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "views", "index.html.erb"), "");
  const uiSpec = (designBoard, decisionFields = {}, changedPath = "DeckList.tsx") => {
    const spec = slicedSpec();
    spec.nodes.find((node) => node.id === "U1").changes = [changedPath];
    Object.assign(spec.nodes[1], decisionFields);
    if (designBoard === undefined) return spec;
    spec.nodes.push({ id: "I1", kind: "design", layer: "behavior", title: "Deck list", code: "list, then detail", board: designBoard });
    spec.edges.push({ from: "U1", kind: "implements", to: "I1" });
    return spec;
  };
  assert.match(denialReason(writeSpec(uiSpec(undefined))), /Rule 18: spec\.nodes: add a behavior design with board \{ id, boxes, pages \}/);
  for (const changedPath of ["views/", "views/index.html.erb", "src/App.tsx/"]) {
    assert.match(denialReason(writeSpec(uiSpec(undefined, {}, changedPath))), /Rule 18: spec\.nodes: add a behavior design with board/);
  }
  assertAllowed(writeSpec(uiSpec(undefined, { mockup: "none" })));
  assertAllowed(writeSpec(uiSpec({ id: "board-1", boxes: ["b1"], pages: [mockupPage] })));
  assert.match(denialReason(writeSpec(uiSpec({ id: "board-1", boxes: ["b1"], pages: [mockupPage.replace(".html", ".svg")] }))), /node I1\.board\.pages\[0\]: save the mockup as an absolute path to an existing \.html file/);
});

test("a sliced spec above low risk is refused until it settles each lifecycle as a valid owned machine or says it has none", () => {
  const uploadMachine = { id: "I1", kind: "design", layer: "machine", title: "Upload lifecycle", at: "graph.ts", states: ["sending", "paused", "done"], transitions: [["sending", "pause", "paused"], ["paused", "resume", "sending"], ["sending", "finish", "done"]] };
  const mediumRiskSpec = (designNodes, decisionFields = {}) => {
    const spec = slicedSpec();
    spec.nodes[0].risk = "medium";
    Object.assign(spec.nodes[1], decisionFields);
    spec.nodes.push({ id: "I2", kind: "design", layer: "behavior", title: "Flow", code: "send, pause, resume" }, ...designNodes);
    spec.edges.push({ from: "U1", kind: "implements", to: "I2" }, ...designNodes.map((design) => ({ from: "U1", kind: "implements", to: design.id })));
    return spec;
  };
  assert.match(denialReason(writeSpec(mediumRiskSpec([]))), /Rule 18: spec\.nodes: add a design node with layer machine .* or a decision with lifecycle: none/);
  assertAllowed(writeSpec(mediumRiskSpec([], { lifecycle: "none" })));
  assertAllowed(writeSpec(mediumRiskSpec([uploadMachine])));
  assert.match(denialReason(writeSpec(mediumRiskSpec([{ ...uploadMachine, transitions: [...uploadMachine.transitions, ["paused", "cancel", "cancelled"]] }]))), /node I1\.transitions: declare cancelled in states/);
  assert.match(denialReason(writeSpec(mediumRiskSpec([{ ...uploadMachine, states: [...uploadMachine.states, "failed"] }]))), /node I1\.transitions: add a transition reaching failed from sending/);
  assert.match(denialReason(writeSpec(mediumRiskSpec([{ ...uploadMachine, at: "upload.ts" }]))), /Rule 12: node I1: list upload\.ts in the changes of a unit implementing this machine/);
});

test("checks repeating the repo gate are denied by id, capped with the count the next write shows", () => {
  const spec = slicedSpec();
  spec.nodes.find((node) => node.id === "U1").checks = [];
  assertAllowed(writeSpec(spec));
  spec.nodes.find((node) => node.id === "U1").checks = [{ run: "npm run typecheck" }];
  for (let unitNumber = 2; unitNumber <= 25; unitNumber++) {
    spec.nodes.push({ id: `U${unitNumber}`, kind: "unit", title: "Add a check", reads: [], changes: [`graph-${unitNumber}.ts`], checks: [{ run: "pnpm test" }], serves: [1] });
    spec.edges.push({ from: `U${unitNumber}`, kind: "implements", to: "D1" });
  }
  const reason = denialReason(writeSpec(spec));
  assert.match(reason, /Rule 14: node U1\.checks\[0\]\.run: drop npm run typecheck: build\.md already runs/);
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
  spec.nodes.push({ id: "U2", kind: "unit", title: "Create the file", reads: [], changes: ["misspelled.ts"], checks: [{ run: "node --test" }], serves: [1] });
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
  unit.checks = [{ run: "npm test" }];
  const reason = denialReason(writeSpec(spec));
  assert.match(reason, /Rule 14: node U1\.checks\[0\]\.run: drop npm test/);
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
    { id: "U2", kind: "unit", title: "Deferred extension", reads: [], changes: ["extension.ts"], checks: [{ run: "node --test" }], serves: [1] },
  );
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U2", kind: "deferredBy", to: "Q1" });
  assertAllowed(writeSpec(spec));
  spec.edges = spec.edges.filter((edge) => edge.kind !== "deferredBy");
  assert.match(denialReason(writeSpec(spec)), /Rule 7: spec\.challengedUnitIds: .*U1, U2.*set status back.*remove challengeStamp/);
});

test("Edit and MultiEdit replay detect dependency cycles without changing disk", () => {
  const spec = slicedSpec();
  spec.nodes.push({ id: "U2", kind: "unit", title: "Render validation", reads: [], changes: ["render.ts"], checks: [{ run: "node --test" }], serves: [1] });
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

test("a real reading budget excess requires a waiver, a unit within budget refuses one, and overlapping paths count once", () => {
  fs.mkdirSync(path.join(repoRoot, "large"));
  fs.writeFileSync(path.join(repoRoot, "large", "contract.txt"), "x".repeat(200001));
  const spec = slicedSpec();
  const unit = spec.nodes.find((node) => node.id === "U1");
  unit.reads = ["large", "large/contract.txt"];
  unit.changes = ["large/contract.txt"];
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*200001 bytes.*budgetWaiver/);
  unit.budgetWaiver = "The migration needs the complete existing contract";
  assertAllowed(writeSpec(spec));
  fs.writeFileSync(path.join(repoRoot, "large", "contract.txt"), "x".repeat(200000));
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1: drop budgetWaiver: .*200000 bytes/);
  fs.mkdirSync(path.join(repoRoot, "spilled"));
  fs.writeFileSync(path.join(repoRoot, "spilled", "a-text.txt"), "x".repeat(30000));
  fs.symlinkSync("z-loop", path.join(repoRoot, "spilled", "z-loop"));
  unit.reads = [];
  unit.changes = ["spilled"];
  assertAllowed(writeSpec(spec));
  fs.rmSync(path.join(repoRoot, "spilled"), { recursive: true });
  spec.nodes.push({ id: "U2", kind: "unit", title: "Generate the contract", reads: [], changes: ["large/generated.txt"], checks: [], serves: [1] });
  spec.edges.push({ from: "U2", kind: "implements", to: "D1" }, { from: "U1", kind: "dependsOn", to: "U2" });
  unit.reads = ["large/generated.txt"];
  unit.changes = ["graph.ts"];
  assertAllowed(writeSpec(spec));
});

test("binary files in a unit cost no reading budget", () => {
  fs.mkdirSync(path.join(repoRoot, "media"));
  const regeneratedVideo = Buffer.alloc(300000, 0x41);
  regeneratedVideo[16] = 0;
  fs.writeFileSync(path.join(repoRoot, "media", "demo.webm"), regeneratedVideo);
  const spec = slicedSpec();
  const unit = spec.nodes.find((node) => node.id === "U1");
  unit.changes = ["media/demo.webm"];
  assertAllowed(writeSpec(spec));
  const wideTextNotes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("readable text line\r\n".repeat(8000), "utf16le")]);
  fs.writeFileSync(path.join(repoRoot, "media", "notes.txt"), wideTextNotes);
  unit.reads = ["media/notes.txt"];
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*320002 bytes.*budgetWaiver/);
});

test("a large file the unit only changes counts at the changed-only cap", () => {
  fs.writeFileSync(path.join(repoRoot, "CHANGELOG.md"), "x".repeat(400000));
  fs.writeFileSync(path.join(repoRoot, "core.ts"), "x".repeat(179000));
  const spec = slicedSpec();
  const unit = spec.nodes.find((node) => node.id === "U1");
  unit.reads = ["core.ts"];
  unit.changes = ["core.ts", "CHANGELOG.md"];
  assertAllowed(writeSpec(spec));
  unit.reads = ["core.ts", "CHANGELOG.md"];
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*579000 bytes.*budgetWaiver/);
  fs.writeFileSync(path.join(repoRoot, "registry.ts"), "x".repeat(250000));
  unit.reads = ["registry.ts"];
  unit.changes = ["registry.ts"];
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*250000 bytes.*budgetWaiver/);
  unit.splits = "registry.ts";
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*add the file the split moves blocks into to changes/);
  unit.changes = ["registry.ts", "registry-sections.ts"];
  assertAllowed(writeSpec(spec));
  fs.writeFileSync(path.join(repoRoot, "registry-sections.ts"), "x".repeat(20000));
  assertAllowed(writeSpec(spec));
  delete unit.splits;
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*270000 bytes.*budgetWaiver/);
  unit.splits = "registry-sections.ts";
  assert.match(denialReason(writeSpec(spec)), /Rule 13: node U1:.*list the splits path in both reads and changes/);
});

test("a goal or branch upstream and a read or assumed decision's evidence are refused until they cite what was read", (testContext) => {
  const citingFields = { G1: "upstream", B1: "upstream", D1: "evidence", D2: "evidence" };
  const sketchCiting = (citedText, citingNodeId = "B1", specRepoRoot = repoRoot) => {
    const citation = (nodeId, fallback) => {
      if (nodeId !== citingNodeId) return { [citingFields[nodeId]]: fallback };
      return citedText === undefined ? {} : { [citingFields[nodeId]]: citedText };
    };
    return {
      status: "sketch",
      request: "Clear the card once its question is answered",
      repoRoot: specRepoRoot,
      nodes: [
        { id: "G1", kind: "goal", text: "The card clears once answered", problem: "An answered card stays on the board", ...citation("G1", "none: the card is new") },
        { id: "B1", kind: "branch", question: "Which hook reports the answer?", leaning: "PostToolUse", ...citation("B1", "none: the hook name is new") },
        { id: "D1", kind: "decision", question: "Where is the card drawn?", answer: "In the card view.", why: "It owns the card.", source: "read", ...citation("D1", "server/cards.ts:212") },
        { id: "D2", kind: "decision", question: "How long does the card fade?", answer: "200ms.", why: "Material's standard exit duration.", source: "assumed", ...citation("D2", "`WebFetch https://m3.material.io/styles/motion`") },
      ],
      edges: [],
    };
  };
  const unevidencedCitations = [undefined, "", "a guess with no evidence", "none", "none:  ", "unknown `?`", "defaced guess", "(<path:line>, <commit sha>, or the `command` that showed it)", "`no idea`", "`TBD later`", "a guess, see ticket 1234567", "guess at 10.30:00", "none: ?", "http://TBD", "a guess https://?"];
  for (const citingNodeId of Object.keys(citingFields)) {
    for (const unevidencedCitation of unevidencedCitations) {
      assert.match(denialReason(writeSpec(sketchCiting(unevidencedCitation, citingNodeId))), new RegExp(`Rule 1: node ${citingNodeId}\\.${citingFields[citingNodeId]}: `), `${citingNodeId} ${unevidencedCitation}`);
    }
    for (const acceptedCitation of ["Report from the title watcher instead, ruled out by server/cards.ts:212", "It worked until 4ecdd12 dropped the answer hook", "`git log -S answerHook` shows the hook was removed on purpose"]) {
      assertAllowed(writeSpec(sketchCiting(acceptedCitation, citingNodeId)));
    }
  }
  assertAllowed(writeSpec(sketchCiting("none: the name is new", "G1")));
  assertAllowed(writeSpec(sketchCiting("none: the name is new", "B1")));
  assertAllowed(writeSpec(sketchCiting("WebFetch https://m3.material.io/styles/motion", "D2")));
  assert.match(denialReason(writeSpec(sketchCiting("none: the fade is new", "D2"))), /Rule 1: node D2\.evidence: research before assuming: .*ToolSearch.*a fetched page's URL/);
  assert.match(denialReason(writeSpec(sketchCiting("none: the name is new", "D1"))), /Rule 1: node D1\.evidence: cite what you read/);
  const grilledWithoutGoalUpstream = sketchCiting(undefined, "G1");
  grilledWithoutGoalUpstream.status = "grilled";
  grilledWithoutGoalUpstream.nodes = grilledWithoutGoalUpstream.nodes.filter((node) => node.kind !== "branch");
  assertAllowed(writeSpec(grilledWithoutGoalUpstream));
  const sketchWithoutGoalProblem = sketchCiting("none: the name is new", "G1");
  delete sketchWithoutGoalProblem.nodes[0].problem;
  assert.match(denialReason(writeSpec(sketchWithoutGoalProblem)), /Rule 1: node G1\.problem: write the problem the goal answers at sketch, as sketch\.md step 4 says/);
  sketchWithoutGoalProblem.status = "grilled";
  sketchWithoutGoalProblem.nodes = sketchWithoutGoalProblem.nodes.filter((node) => node.kind !== "branch");
  assertAllowed(writeSpec(sketchWithoutGoalProblem));
  const citedRepository = makeRepo();
  testContext.after(() => removeAll(citedRepository));
  commitFile(citedRepository, "a.txt", "one\n");
  let allDigitCommit;
  for (let attempt = 0; allDigitCommit === undefined && attempt < 5000; attempt += 1) {
    const commitProcess = spawnSync("git", ["-C", citedRepository, "commit-tree", "HEAD^{tree}", "-m", `attempt ${attempt}`], { encoding: "utf8" });
    const abbreviatedCommit = commitProcess.stdout.slice(0, 7);
    if (/^\d{7}$/.test(abbreviatedCommit)) allDigitCommit = abbreviatedCommit;
  }
  assertAllowed(writeSpec(sketchCiting(`It worked until ${allDigitCommit} dropped the answer hook`, "B1", citedRepository)));
  assertAllowed(writeSpec(sketchCiting(`It worked until ${allDigitCommit} dropped the answer hook`, "D1", citedRepository)));
  assert.match(denialReason(writeSpec(sketchCiting("It worked until abc1234 dropped the answer hook", "B1", citedRepository))), /Rule 1: node B1\.upstream: say what one level up/);
  const fetchMarkerPath = path.join(citedRepository, "fetched");
  for (const [configKey, configValue] of [["extensions.partialClone", "origin"], ["remote.origin.promisor", "true"], ["remote.origin.url", path.join(citedRepository, "nowhere")], ["remote.origin.uploadpack", `touch ${fetchMarkerPath}; false`]]) {
    spawnSync("git", ["-C", citedRepository, "config", configKey, configValue]);
  }
  assert.match(denialReason(writeSpec(sketchCiting("It worked until 1234567890abcdef1234567890abcdef12345678 dropped the answer hook", "B1", citedRepository))), /Rule 1: node B1\.upstream: say what one level up/);
  assert.equal(fs.existsSync(fetchMarkerPath), false, "the commit lookup fetched from the spec's repository");
});

test("unrelated writes and malformed or unreadable inputs allow silently", () => {
  assertAllowed(writeSpec({}, path.join(temporaryHome, "outside.json")));
  const unreadableSpecPath = path.join(temporaryHome, ".agents", "specs", "unreadable.json");
  fs.mkdirSync(unreadableSpecPath);
  assertAllowed(writeSpec({}, unreadableSpecPath));
  for (const payload of [null, false, [], {}, { tool_name: "Write", tool_input: null }, { tool_name: "Write", tool_input: { file_path: specPath, content: "{invalid" } }, { tool_name: "Edit", tool_input: { file_path: unreadableSpecPath, old_string: "old", new_string: "new" } }]) {
    assertAllowed(runHook("validate-spec.mjs", payload, { HOME: temporaryHome }));
  }
});

test("a Codex apply_patch and an agy write_file of an invalid spec are both denied", () => {
  const spec = slicedSpec();
  spec.nodes.find((node) => node.id === "G1").risk = "urgent";
  const specText = JSON.stringify(spec);
  const codexPatch = ["*** Begin Patch", `*** Add File: ${specPath}`, `+${specText}`, "*** End Patch"].join("\n");
  const codexProcess = runHook("validate-spec.mjs", { turn_id: "codex-turn", tool_name: "apply_patch", tool_input: { command: codexPatch } }, { HOME: temporaryHome });
  assert.match(denialReason(codexProcess), /Rule 1: node G1\.risk/);
  const agyProcess = runHook("validate-spec.mjs", {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: { name: "write_file", args: { Path: specPath, Content: specText } },
  }, { HOME: temporaryHome }, process.cwd(), ["--agent=agy"]);
  const agyDecision = JSON.parse(agyProcess.stdout);
  assert.equal(agyDecision.decision, "deny");
  assert.match(agyDecision.reason, /Rule 1: node G1\.risk/);
});

test("a Codex apply_patch moving a spec to a new name is judged on the moved content", () => {
  const spec = slicedSpec();
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const riskLine = `      "risk": "${spec.nodes.find((node) => node.id === "G1").risk}",`;
  const movePatch = ["*** Begin Patch", `*** Update File: ${specPath}`, `*** Move to: ${path.join(path.dirname(specPath), "moved.json")}`, "@@", `-${riskLine}`, `+${riskLine.replace(/"risk": "[a-z]+"/, '"risk": "urgent"')}`, "*** End Patch"].join("\n");
  const hookProcess = runHook("validate-spec.mjs", { tool_name: "apply_patch", tool_input: { command: movePatch } }, { HOME: temporaryHome }, process.cwd(), ["--agent=codex"]);
  assert.match(denialReason(hookProcess), /Rule 1: node G1\.risk/);
});
