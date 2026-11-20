import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

const branch = "if (ready) { start(); } else { stop(); }";

function writePayload(extension, content) {
  return { tool_name: "Write", tool_input: { file_path: `/nonexistent/branch${extension}`, content } };
}

function patchPayload(...lines) {
  return {
    tool_name: "apply_patch",
    tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
  };
}

const deniedScenarios = [
  { name: "a Write adds an else statement", payload: writePayload(".js", branch), sample: branch },
  {
    name: "an Edit adds an else-if statement",
    payload: {
      tool_name: "Edit",
      tool_input: {
        file_path: "/nonexistent/branch.ts",
        old_string: "if (ready) { start(); }",
        new_string: "if (ready) { start(); } else if (waiting) { stop(); }",
      },
    },
    sample: "else if (waiting)",
  },
  {
    name: "a MultiEdit sums growth across fragments",
    payload: {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/nonexistent/branch.js",
        edits: [
          { old_string: "start();", new_string: branch },
          { old_string: "stop();", new_string: "if (waiting) { wait(); } else { stop(); }" },
        ],
      },
    },
    sample: branch,
    count: 2,
  },
  { name: "Python elif counts", payload: writePayload(".py", "if ready:\n    start()\nelif waiting:\n    stop()"), sample: "elif waiting:" },
  { name: "Python conditional else counts", payload: writePayload(".py", "if ready:\n    start()\nelse:\n    stop()"), sample: "else:" },
  { name: "shell elif counts", payload: writePayload(".sh", "if ready; then\nstart\nelif waiting; then\nstop\nfi"), sample: "elif waiting; then" },
  { name: "Ruby elsif counts", payload: writePayload(".rb", "if ready\n  start\nelsif waiting\n  stop\nend"), sample: "elsif waiting" },
  { name: "two occurrences on one line both count", payload: writePayload(".js", `${branch} ${branch}`), sample: branch, count: 2 },
  { name: "a branch after a closed block comment counts", payload: writePayload(".js", `/* else\nelse */ ${branch}`), sample: branch },
  { name: "a branch after a closed template counts", payload: writePayload(".js", `const banner = \`else\`; ${branch}`), sample: branch },
  { name: "a branch after a heredoc counts", payload: writePayload(".sh", "cat <<'EOF'\nelse\nEOF\nif ready; then start; else stop; fi"), sample: "else stop; fi" },
  {
    name: "an apply_patch update adds a branch",
    payload: patchPayload("*** Update File: branch.ts", "@@ optional context", "-start();", `+${branch}`),
    sample: branch,
  },
  {
    name: "an apply_patch addition counts branches across code files only",
    payload: patchPayload("*** Add File: first.js", `+${branch}`, "*** Add File: second.py", "+if ready:", "+    start()", "+else:", "+    stop()", "*** Add File: notes.md", "+else"),
    sample: branch,
    count: 2,
  },
  {
    name: "a moved patch uses the destination code language",
    payload: patchPayload("*** Update File: branch.txt", "*** Move to: branch.js", "@@", "-start();", `+${branch}`, "*** End of File"),
    sample: branch,
  },
  {
    name: "a patch file losing branches does not mask another file gaining one",
    payload: patchPayload("*** Update File: old.js", `-${branch}`, `-${branch}`, "*** Add File: new.js", `+${branch}`),
    sample: branch,
  },
  {
    name: "an empty patch hunk line reads as blank context",
    payload: patchPayload("*** Update File: blank.js", "@@", " function f(){", "", "-  return 1;", "+  if (x) { return 1; } else { return 2; }", " }"),
    sample: "else { return 2; }",
  },
];

for (const scenario of deniedScenarios) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-else.mjs", scenario.payload);
    assert.equal(hookProcess.status, 0);
    assert.equal(hookProcess.stderr, "");
    const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
    assert.equal(decision.hookEventName, "PreToolUse");
    assert.equal(decision.permissionDecision, "deny");
    assert.match(decision.permissionDecisionReason, /No-else guard blocked this write to .*\./);
    assert.ok(decision.permissionDecisionReason.includes(scenario.sample));
    assert.ok(decision.permissionDecisionReason.includes(`adds ${scenario.count ?? 1} net-new else statement(s):`));
    assert.match(decision.permissionDecisionReason, /Fix: invert the condition and return, continue, break, or throw early/);
    assert.match(decision.permissionDecisionReason, /Ternaries, Rust let-else, Python for\/while\/try\/except else, and Ruby begin\/rescue else are exempt/);
  });
}

const allowedWrites = [
  { name: "ternaries pass", extension: ".ts", content: "const action = ready ? start : stop;" },
  { name: "keywords in strings and comments pass", extension: ".js", content: "const label = 'else elif elsif'; // else\n/* else\n * elsif\n */\nconst other = \"else\";" },
  { name: "inline and multiline templates pass", extension: ".tsx", content: "const banner = `else ${name}`;\nconst multiline = `\nelse if (ready)\nCan't do anything else\n`;" },
  { name: "Python triple quoted strings pass", extension: ".py", content: "message = \"\"\"\nelse:\nCan't do anything else\n\"\"\"\nother = '''elif\nelse'''\n# else" },
  { name: "shell heredocs pass", extension: ".bash", content: "cat <<'FIRST' <<\\SECOND\nelse\nFIRST\nelif ready\nSECOND\ncat <<-LAST\n\telse\n\tLAST" },
  { name: "multiline quoted shell strings pass", extension: ".zsh", content: "message=\"ready\nelse\nwaiting\"\n# elif" },
  { name: "Rust let-else passes", extension: ".rs", content: "let Some(value) = candidate else { return; };" },
  { name: "Python for and while else pass", extension: ".py", content: "for item in items:\n    consume(item)\nelse:\n    finish()\nwhile ready:\n    consume()\nelse:\n    finish()" },
  { name: "Python try-except else passes", extension: ".py", content: "try:\n    start()\nexcept Failure:\n    stop()\nelse:\n    finish()\nfinally:\n    cleanup()" },
  { name: "Python nested openers match the same indentation", extension: ".py", content: "for item in items:\n    if ready:\n        consume(item)\n\n# else\nelse:\n    finish()" },
  { name: "an unmatched Rust lifetime quote does not open a string on later lines", extension: ".rs", content: "fn name(&self) -> &'static str {\n    \"don't panic, else fine\"\n}" },
  { name: "Python conditional expressions pass", extension: ".py", content: "label = 'yes' if ok else 'no'" },
  { name: "Ruby rescue else passes", extension: ".rb", content: "begin\n  start\nrescue Failure\n  if waiting\n    stop\n  end\nelse\n  finish\nend" },
];

for (const scenario of allowedWrites) {
  test(scenario.name, () => {
    const hookProcess = runHook("block-else.mjs", writePayload(scenario.extension, scenario.content));
    assert.equal(hookProcess.status, 0);
    assert.equal(hookProcess.stdout, "");
    assert.equal(hookProcess.stderr, "");
  });
}

test("a conditional else nested inside an exempt Python loop still counts", () => {
  const hookProcess = runHook("block-else.mjs", writePayload(".py", "for item in items:\n    if ready:\n        consume(item)\n    else:\n        stop()\nelse:\n    finish()"));
  const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /adds 1 net-new else/);
});

const allowedPayloads = [
  null, "malformed", [], {},
  { tool_name: "Bash", tool_input: { command: branch } },
  { tool_name: "Write", tool_input: { file_path: 42, content: branch } },
  { tool_name: "Write", tool_input: { file_path: {}, content: branch } },
  { tool_name: "Write", tool_input: { file_path: "/nonexistent/branch.js" } },
  { tool_name: "Write", tool_input: { file_path: "/nonexistent/branch.js", content: {} } },
  { tool_name: "Edit", tool_input: { file_path: "/nonexistent/branch.js", old_string: {}, new_string: branch } },
  { tool_name: "MultiEdit", tool_input: { file_path: "/nonexistent/branch.js", edits: [null] } },
  { tool_name: "apply_patch", tool_input: { command: {} } },
  { tool_name: "apply_patch", tool_input: { command: `*** Add File: branch.js\n+${branch}` } },
  patchPayload("*** Update File: branch.js", "@@", `+${branch}`, "unparseable"),
  patchPayload("*** Add File: branch.js", `+${branch}`, "*** Unknown File: other.js"),
  patchPayload("*** Add File: notes.md", "+else"),
  patchPayload("*** Delete File: branch.js"),
  patchPayload("*** Update File: branch.js", "@@", ` ${branch}`, "-start();", "+stop();"),
  patchPayload("*** Update File: branch.js", "@@", `-${branch}`, " start();", "@@ another hunk", `+${branch}`),
  patchPayload("*** Update File: branch.js", "*** Move to: moved.js", "@@", `-${branch}`, `+${branch}`),
  patchPayload("*** Add File: branch.js", "+const banner = `", "+else", "+`;"),
  patchPayload("*** Add File: branch.sh", "+cat <<'EOF'", "+else", "+EOF"),
  patchPayload("*** Add File: branch.py", "+for item in items:", "+    consume(item)", "+else:", "+    finish()"),
  patchPayload("*** Add File: branch.rs", "+let Some(value) = candidate else { return; };"),
  {
    tool_name: "Edit",
    tool_input: { file_path: "/nonexistent/branch.js", old_string: `${branch}\nstart();`, new_string: `start();\n${branch}` },
  },
  {
    tool_name: "MultiEdit",
    tool_input: { file_path: "/nonexistent/branch.js", edits: [{ old_string: branch, new_string: "start();" }, { old_string: "stop();", new_string: branch }] },
  },
];

test("preserved branches, malformed calls, deleted files, and exempt patches allow silently", () => {
  for (const payload of allowedPayloads) {
    const hookProcess = runHook("block-else.mjs", payload);
    assert.equal(hookProcess.status, 0, JSON.stringify(payload));
    assert.equal(hookProcess.stdout, "", JSON.stringify(payload));
    assert.equal(hookProcess.stderr, "", JSON.stringify(payload));
  }
});

test("non-statement languages bypass the guard", () => {
  for (const extension of [".hs", ".nix", ".elm", ".sql", ".css", ".scss", ".md", ".json", ".yaml", ".proto", ".sol", ".txt", ""]) {
    const hookProcess = runHook("block-else.mjs", writePayload(extension, "else elif elsif"));
    assert.equal(hookProcess.status, 0);
    assert.equal(hookProcess.stdout, "", extension);
  }
});

const replayScenarios = [
  { name: "a Write moves an existing branch", baseline: `${branch}\nstart();`, toolName: "Write", edit: { content: `start();\n${branch}` } },
  { name: "an Edit inside a template uses the on-disk context", baseline: "const message = `\nready\n`;", edit: { old_string: "ready", new_string: "else" } },
  { name: "an Edit inside a heredoc uses the on-disk context", extension: ".sh", baseline: "cat <<EOF\nready\nEOF", edit: { old_string: "ready", new_string: "else" } },
  { name: "a MultiEdit moves a branch on disk", baseline: `${branch}\nstart();`, toolName: "MultiEdit", edit: { edits: [{ old_string: branch, new_string: "" }, { old_string: "start();", new_string: branch }] } },
  { name: "an unmatched edit falls back to fragments", baseline: "start();", edit: { old_string: "missing();", new_string: branch }, shouldDeny: true },
  { name: "replace_all counts every inserted occurrence", baseline: "start();\nstart();", edit: { old_string: "start();", new_string: branch, replace_all: true }, shouldDeny: true, count: 2 },
  { name: "a directory target fails open", isDirectory: true, edit: { content: branch }, toolName: "Write" },
];

for (const scenario of replayScenarios) {
  test(scenario.name, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-else-hook-"));
    const filePath = path.join(directory, `branch${scenario.extension ?? ".js"}`);
    try {
      if (scenario.isDirectory) fs.mkdirSync(filePath);
      if (!scenario.isDirectory) fs.writeFileSync(filePath, scenario.baseline);
      const hookProcess = runHook("block-else.mjs", {
        tool_name: scenario.toolName ?? "Edit",
        tool_input: { file_path: filePath, ...scenario.edit },
      });
      assert.equal(hookProcess.status, 0);
      assert.equal(hookProcess.stderr, "");
      if (scenario.shouldDeny) {
        const decision = JSON.parse(hookProcess.stdout).hookSpecificOutput;
        assert.equal(decision.permissionDecision, "deny");
        assert.ok(decision.permissionDecisionReason.includes(`adds ${scenario.count ?? 1} net-new else`));
        return;
      }
      assert.equal(hookProcess.stdout, "");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}


test("an agy replace_file_content adding an else is denied in agy's reply shape", () => {
  const hookProcess = runHook("block-else.mjs", {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: {
      name: "replace_file_content",
      args: { TargetFile: "/nonexistent/branch.ts", ReplacementChunks: [{ TargetContent: "start();", ReplacementContent: branch }] },
    },
  }, {}, process.cwd(), ["--agent=agy"]);
  assert.equal(hookProcess.status, 0, hookProcess.stderr);
  const decision = JSON.parse(hookProcess.stdout);
  assert.equal(decision.decision, "deny");
  assert.ok(decision.reason.includes(branch));
});
