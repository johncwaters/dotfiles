import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { commitFile, makeRepo, writeExecutable } from "../../skills/landing/test/helpers.ts";
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

test("review-ladder writes cannot grow across runtime, alias, and worktree paths", () => {
  const ladderSuffixes = [
    "skills/landing/SKILL.md",
    "skills/gating-reviews/SKILL.md",
    "skills/gating-reviews/subskills/review.md",
    "skills/reviewing-code/SKILL.md",
    "skills/swarming-reviews/SKILL.md",
    "skills/gating-reviews/subskills/fix.md",
    "workflows/qa-swarm.js",
  ];
  const ladderRoots = [".claude", ".dotfiles/ai", "worktree/ai"];
  for (const ladderRoot of ladderRoots) {
    for (const ladderSuffix of ladderSuffixes) {
      const filePath = path.join(validatorHome, ladderRoot, ladderSuffix);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "rule\n");
      const denialReason = readDenialReason(validateWrite({ file_path: filePath, content: "rules\n" }));
      assert.ok(denialReason.includes("Where: 6 bytes, prior 5"));
      assert.ok(denialReason.includes(`Why: ${path.basename(filePath)} is a review-ladder file and may not grow; ceremony accumulates one reasonable rule at a time`));
      assert.ok(denialReason.includes("Fix: Retire an existing rule or step to make room for the new one, or drop the addition."));
      for (const content of ["rule\n", "rule"]) {
        const allowedWriteProcess = validateWrite({ file_path: filePath, content });
        assert.equal(allowedWriteProcess.status, 0, allowedWriteProcess.stderr);
        assert.equal(allowedWriteProcess.stdout, "");
      }
    }
  }
});

test("review-ladder suffix matching normalizes separators and dot segments", () => {
  const filePaths = [
    validatorHome + "/normalized/skills/landing/../landing/SKILL.md",
    path.join(validatorHome, "windows\\skills\\landing\\SKILL.md"),
  ];
  for (const filePath of filePaths) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "rule");
    assert.match(readDenialReason(validateWrite({ file_path: filePath, content: "rules" })), /review-ladder file/);
  }
});

function wellFormedSkill(skillName, body = "## Step 1: Act\n\nAct on the request.\n") {
  const description = "Lands a finished change by reviewing it once, fixing what the review proved, and committing it with a typed outcome. Use when the carbon unit says commit this, land it, or ship the finished work to mainline through the review gate.";
  return `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# Title\n\n${body}`;
}

test("dotfiles skill writes are denied only when they add structure violations", () => {
  const dotfilesRoot = path.join(validatorHome, "structure");
  fs.mkdirSync(path.join(dotfilesRoot, "profiles"), { recursive: true });
  const skillPath = path.join(dotfilesRoot, "ai/skills/shipping/SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  const foreignSkillProcess = validateWrite({ file_path: path.join(validatorHome, "project/.claude/skills/shipping/SKILL.md"), content: "Do not wait.\n" });
  assert.equal(foreignSkillProcess.stdout, "", foreignSkillProcess.stderr);
  const newSkillProcess = validateWrite({ file_path: skillPath, content: wellFormedSkill("shipping") });
  assert.equal(newSkillProcess.stdout, "", newSkillProcess.stderr);
  for (const invalidName of ["lander", "sing", "ing", "pdfs-processing"]) {
    const invalidPath = path.join(dotfilesRoot, "ai/skills", invalidName, "SKILL.md");
    const gerundDenial = readDenialReason(validateWrite({ file_path: invalidPath, content: wellFormedSkill(invalidName) }));
    assert.match(gerundDenial, /does not start with a gerund/);
    assert.ok(gerundDenial.includes("Rename to a gerund phrase, verb first (processing-pdfs, reviewing-code)."));
  }
  fs.writeFileSync(skillPath, wellFormedSkill("shipping", "## Step 2: Act\n\nNever wait.\n"));
  const keptViolationsProcess = validateWrite({ file_path: skillPath, content: wellFormedSkill("shipping", "## Step 2: Act\n\nNever stall.\n") });
  assert.equal(keptViolationsProcess.stdout, "", keptViolationsProcess.stderr);
  const denialReason = readDenialReason(validateWrite({ file_path: skillPath, content: wellFormedSkill("shipping", "## Step 2: Act\n\nNever stall. Never wait.\n") }));
  assert.match(denialReason, /Where: line \d+: prohibition 'Never'\n/);
  assert.match(denialReason, /Fix: State the action to take instead of the one to skip\./);
});

test("new review-ladder files and other skill files may grow", () => {
  const newFilePath = path.join(validatorHome, "new/skills/landing/SKILL.md");
  const otherSkillPath = path.join(validatorHome, "skills/writing-in-voice/SKILL.md");
  const similarSuffixPath = path.join(validatorHome, "other-skills/landing/SKILL.md");
  for (const filePath of [otherSkillPath, similarSuffixPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "rule");
  }
  for (const filePath of [newFilePath, otherSkillPath, similarSuffixPath]) {
    const content = filePath === newFilePath ? wellFormedSkill("landing") : "rules";
    const allowedWriteProcess = validateWrite({ file_path: filePath, content });
    assert.equal(allowedWriteProcess.status, 0, allowedWriteProcess.stderr);
    assert.equal(allowedWriteProcess.stdout, "");
  }
});

test("review-ladder growth is measured in UTF-8 bytes", () => {
  const filePath = path.join(validatorHome, "bytes/skills/swarming-reviews/SKILL.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "a");
  assert.match(readDenialReason(validateWrite({ file_path: filePath, content: "\u00e9" })), /2 bytes, prior 1/);
});

test("review-ladder Edit checks explicit content and replayed replacements", () => {
  const filePath = path.join(validatorHome, "edit/skills/reviewing-code/SKILL.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "rule rule");
  const toolInputs = [
    { filePath, content: "rules rule", old_string: "absent" },
    { file_path: filePath, old_string: "rule", new_string: "rules" },
    { file_path: filePath, old_string: "rule", new_string: "rules", replace_all: true },
  ];
  for (const toolInput of toolInputs) {
    const hookProcess = runHook("validate-file.mjs", { tool_name: "Edit", tool_input: toolInput }, validatorEnvironment);
    assert.match(readDenialReason(hookProcess), /review-ladder file/);
  }
  assert.equal(fs.readFileSync(filePath, "utf8"), "rule rule");
});

test("review-ladder MultiEdit checks the final full content", () => {
  const filePath = path.join(validatorHome, "multi/skills/gating-reviews/subskills/fix.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "rule rule");
  for (const replacement of ["rules", "rule", "rul"]) {
    const hookProcess = runHook("validate-file.mjs", {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: filePath,
        edits: [
          { old_string: "rule", new_string: "pending", replace_all: true },
          { old_string: "pending", new_string: replacement, replace_all: true },
        ],
      },
    }, validatorEnvironment);
    if (replacement === "rules") {
      assert.match(readDenialReason(hookProcess), /11 bytes, prior 9/);
      continue;
    }
    assert.equal(hookProcess.status, 0, hookProcess.stderr);
    assert.equal(hookProcess.stdout, "");
  }
  assert.equal(fs.readFileSync(filePath, "utf8"), "rule rule");
});

test("review-ladder ceiling is the committed size, so a shrink can be grown back up to it", () => {
  const repository = makeRepo();
  after(() => removeAll(repository));
  commitFile(repository, "skills/landing/SKILL.md", "rule rule\n");
  const filePath = path.join(repository, "skills/landing/SKILL.md");
  fs.writeFileSync(filePath, "rule\n");
  const regrowthProcess = validateWrite({ file_path: filePath, content: "rule rule\n" });
  assert.equal(regrowthProcess.status, 0, regrowthProcess.stderr);
  assert.equal(regrowthProcess.stdout, "");
  const denialReason = readDenialReason(validateWrite({ file_path: filePath, content: "rule rules\n" }));
  assert.ok(denialReason.includes("Where: 11 bytes, committed 10"));
});

test("untracked review-ladder files fall back to the on-disk size", () => {
  const repository = makeRepo();
  after(() => removeAll(repository));
  commitFile(repository, "README.md", "readme\n");
  const filePath = path.join(repository, "skills/gating-reviews/subskills/fix.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "rule");
  const denialReason = readDenialReason(validateWrite({ file_path: filePath, content: "rules" }));
  assert.ok(denialReason.includes("Where: 5 bytes, prior 4"));
});

test("an engine that exits non-zero without a parse diagnostic for the written file allows the write and leaves JSON to the native parser", () => {
  const enginePath = path.join(validatorHome, "unjudging-biome");
  const engineEnvironment = { ...validatorEnvironment, BIOME_BIN: enginePath };
  const validWrites = [
    { file_path: "a.ts", content: "const count = 1;\n" },
    { file_path: "a.json", content: '{"valid":true}' },
    { file_path: "biome.json", content: '{"formatter":{"enabled":true}}' },
  ];
  const engineFailureOutputs = [
    "Error: Cannot find module '@biomejs/cli-darwin-arm64/biome'",
    "/project/biome.json:1:34 parse\nconfiguration\n  Biome exited because the configuration resulted in errors.",
  ];
  for (const engineFailureOutput of engineFailureOutputs) {
    writeExecutable(enginePath, `#!${process.execPath}
console.error(${JSON.stringify(engineFailureOutput)});
process.exit(1);
`);
    for (const validWrite of validWrites) {
      const hookProcess = validateWrite(validWrite, engineEnvironment);
      assert.equal(hookProcess.status, 0, hookProcess.stderr);
      assert.equal(hookProcess.stdout, "", `${validWrite.file_path} after ${engineFailureOutput}`);
    }
    assert.match(readDenialReason(validateWrite({ file_path: "a.json", content: "{bad}" }, engineEnvironment)), /invalid JSON/);
  }
});

test("a failed diagnostic harvest cannot turn a syntax denial into an allow", () => {
  const enginePath = path.join(validatorHome, "biome");
  writeExecutable(enginePath, `#!${process.execPath}
if (process.argv.includes("format")) console.error("a.ts:1:15 parse");
process.exit(1);
`);
  const denialReason = readDenialReason(validateWrite(
    { file_path: "a.ts", content: "const count = ;" },
    { ...validatorEnvironment, BIOME_BIN: enginePath },
  ));
  assert.match(denialReason, /invalid TS syntax/);
});

test("a workflow script parses as the async function body the runtime runs it as", () => {
  const enginePath = path.join(validatorHome, "module-syntax-engine");
  writeExecutable(enginePath, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const source = require("node:fs").readFileSync(0, "utf8");
const checkStatus = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source }).status;
if (checkStatus !== 0) console.error("review.js:1:1 parse");
process.exit(checkStatus);
`);
  const engineEnvironment = { ...validatorEnvironment, BIOME_BIN: enginePath };
  const workflowScript = "export const meta = { name: 'review' }\nconst verdict = await agent('review')\nreturn verdict\n";
  const workflowWrite = validateWrite({ file_path: "workflows/scripts/review.js", content: workflowScript }, engineEnvironment);
  assert.equal(workflowWrite.status, 0, workflowWrite.stderr);
  assert.equal(workflowWrite.stdout, "");
  for (const deniedWrite of [
    { file_path: "workflows/scripts/review.js", content: `${workflowScript}return (\n` },
    { file_path: "workflows/scripts/review.js", content: `${workflowScript}}\nfunction leftover() {\n` },
    { file_path: "workflows/scripts/review.js", content: `${workflowScript}})\nlog(() => {\n` },
    { file_path: "source/review.js", content: workflowScript },
  ]) {
    assert.match(readDenialReason(validateWrite(deniedWrite, engineEnvironment)), /invalid JS syntax/);
  }
});
