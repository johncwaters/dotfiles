import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function runHook(scriptName, payload) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, scriptName)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function canRead(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function runGit(repository, argumentsList) {
  const processResult = spawnSync("git", argumentsList, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0, processResult.stderr);
  return (processResult.stdout ?? "").trim();
}

function makeRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "finding-scope-hook-"));
  runGit(repository, ["init", "-q"]);
  runGit(repository, ["config", "user.name", "Test User"]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "a.txt"), "one\n", "utf8");
  runGit(repository, ["add", "--", "a.txt"]);
  runGit(repository, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repository, "a.txt"), "two\n", "utf8");
  return repository;
}

function findingsFor(filePath) {
  return [
    "STRUCTURED_FINDINGS:",
    `- file: ${filePath} | line: 1 | side: RIGHT | severity: LOW | reviewer: code/logic | body: example`,
    "",
    "OVERALL_SUMMARY:",
    "Example summary.",
  ].join("\n");
}

test("spawn prompt missing scope markers is denied", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: { model: "opus", prompt: "Scope:\nai/hooks" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Out of scope:/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Definition of done:/);
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /Scope:\nOut of scope:\nDefinition of done:/,
  );
});

test("fork spawn without scope markers is allowed", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: { subagent_type: "fork", prompt: "Inherited conversation." },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("spawn prompt with every scope marker is allowed", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Task",
    tool_input: {
      model: "opus",
      prompt: "## scope:\nai/hooks\n### OUT OF SCOPE:\nai/agents\nDefinition of done:\nTests pass.",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("spawn prompt with scope markers still requires a model", () => {
  const processResult = runHook("enforce-spawn-model.mjs", {
    tool_name: "Agent",
    tool_input: {
      prompt: "Scope:\nai/hooks\nOut of scope:\nai/agents\nDefinition of done:\nTests pass.",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explicit model pin/);
});

test("an unchallenged plan is denied with skill instructions", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n2. Test the thing" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /plan-challenge/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /CHALLENGE:/);
});

test("a stamped plan is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\nCHALLENGE: 1 kept, 0 shrunk, 1 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a heading-style stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n## Challenge: 1 kept, 0 shrunk, 0 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("mid-plan challenge prose is denied", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nChallenge: is step 3 really needed?\n\n2. Test the thing",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("a stamp followed by later plan lines is denied", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nCHALLENGE: 1 kept, 0 shrunk, 1 cut\n\n2. One more thing",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("the deny reason names the path for a context that cannot spawn agents", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /cannot spawn agents returns the plan to its caller unstamped/,
  );
});

test("a bold stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n**CHALLENGE: 2 kept, 1 shrunk, 0 cut**" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an inline-code stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n`CHALLENGE: 1 kept, 0 shrunk, 0 cut`" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an italic stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n_CHALLENGE: 1 kept, 0 shrunk, 0 cut_" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a list-item stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n- CHALLENGE: 2 kept, 1 shrunk, 0 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a single-lane suffix on the stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nCHALLENGE: 2 kept, 1 shrunk, 0 cut (single lane: leverage)",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("the plan gate ignores other tools and empty plans", () => {
  const otherToolResult = runHook("challenge-plan.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "a.txt", content: "no plan here" },
  });
  assert.equal(otherToolResult.status, 0);
  assert.equal(otherToolResult.stdout, "");

  const emptyPlanResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "   " },
  });
  assert.equal(emptyPlanResult.status, 0);
  assert.equal(emptyPlanResult.stdout, "");
});

test("finding scope warns only for files outside the diff", () => {
  const repository = makeRepository();
  try {
    const outOfScopeResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: { content: [{ type: "text", text: findingsFor("b.txt") }] },
    });
    assert.equal(outOfScopeResult.status, 0);
    const warning = JSON.parse(outOfScopeResult.stdout);
    assert.match(warning.hookSpecificOutput.additionalContext, /b\.txt/);
    assert.equal(warning.hookSpecificOutput.hookEventName, "PostToolUse");

    const inScopeResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Task",
      tool_response: findingsFor("a.txt"),
    });
    assert.equal(inScopeResult.status, 0);
    assert.equal(inScopeResult.stdout, "");

    fs.writeFileSync(path.join(repository, "new.txt"), "untracked\n", "utf8");
    const untrackedResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: findingsFor("new.txt"),
    });
    assert.equal(untrackedResult.status, 0);
    assert.equal(untrackedResult.stdout, "");
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope ignores placeholder file entries", () => {
  const repository = makeRepository();
  try {
    const processResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: [
        "STRUCTURED_FINDINGS:",
        '- file: <path> | line: <number or "general"> | side: RIGHT | severity: LOW',
        "- file: (none) | line: general | side: RIGHT | severity: LOW",
        "",
        "OVERALL_SUMMARY:",
      ].join("\n"),
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope reports real paths alongside placeholders", () => {
  const repository = makeRepository();
  try {
    const processResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: [
        "STRUCTURED_FINDINGS:",
        '- file: <path> | line: <number or "general"> | side: RIGHT | severity: LOW',
        "- file: b.txt | line: 1 | side: RIGHT | severity: LOW",
        "",
        "OVERALL_SUMMARY:",
      ].join("\n"),
    });

    assert.equal(processResult.status, 0);
    const warning = JSON.parse(processResult.stdout);
    assert.match(warning.hookSpecificOutput.additionalContext, /b\.txt/);
    assert.doesNotMatch(warning.hookSpecificOutput.additionalContext, /<path>/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope ignores a placeholder line value followed by a later line field", () => {
  const repository = makeRepository();
  try {
    const processResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: [
        "STRUCTURED_FINDINGS:",
        '- file: b.txt | line: <number or "general"> | side: RIGHT | body: x | line: 5',
        "",
        "OVERALL_SUMMARY:",
      ].join("\n"),
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope parses a padded file value without backtracking blowup", () => {
  const repository = makeRepository();
  try {
    const startedAtMs = Date.now();
    const processResult = runHook("check-finding-scope.mjs", {
      cwd: repository,
      tool_name: "Agent",
      tool_response: [
        "STRUCTURED_FINDINGS:",
        `- file:${" ".repeat(4000)}| line: x`,
        "",
        "OVERALL_SUMMARY:",
      ].join("\n"),
    });
    const elapsedMs = Date.now() - startedAtMs;

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
    assert.ok(elapsedMs < 2000, `hook took ${elapsedMs}ms`);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope is silent without a structured findings block", () => {
  const processResult = runHook("check-finding-scope.mjs", {
    cwd: process.cwd(),
    tool_name: "Agent",
    tool_response: "No structured review output.",
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

function runCavemanUltraWithHome(home) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, "caveman-ultra.mjs")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CAVEMAN_DEFAULT_MODE: "ultra" },
  });
}

function makeHomeHoldingUltraFlag() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-ultra-hook-"));
  fs.mkdirSync(path.join(home, ".claude"));
  return home;
}

test("the caveman flag is written for its owner only", () => {
  const home = makeHomeHoldingUltraFlag();
  const flagPath = path.join(home, ".claude", ".caveman-active");
  fs.writeFileSync(flagPath, "ultra", "utf8");
  fs.chmodSync(flagPath, 0o644);

  const processResult = runCavemanUltraWithHome(home);

  assert.equal(processResult.status, 0);
  assert.equal(fs.readFileSync(flagPath, "utf8"), "ultra");
  assert.equal(fs.statSync(flagPath).mode & 0o777, 0o600);
});

test("a symlinked caveman flag path is replaced rather than followed", () => {
  const home = makeHomeHoldingUltraFlag();
  const flagPath = path.join(home, ".claude", ".caveman-active");
  const redirectedPath = path.join(home, "redirected-target");
  fs.writeFileSync(redirectedPath, "keep me", "utf8");
  fs.symlinkSync(redirectedPath, flagPath);

  const processResult = runCavemanUltraWithHome(home);

  assert.equal(processResult.status, 0);
  assert.equal(fs.readFileSync(redirectedPath, "utf8"), "keep me");
  assert.equal(fs.lstatSync(flagPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(flagPath, "utf8"), "ultra");
});

test("the caveman hook leaves no temporary flag behind", () => {
  const home = makeHomeHoldingUltraFlag();
  fs.writeFileSync(path.join(home, ".claude", ".caveman-active"), "ultra", "utf8");

  assert.equal(runCavemanUltraWithHome(home).status, 0);

  const claudeEntries = fs.readdirSync(path.join(home, ".claude"));
  assert.deepEqual(claudeEntries, [".caveman-active"]);
});

test("a write adding a comment line to a code file is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/nonexistent/a.js", content: "// increment counter\nconst x = 1;\n" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /No-comments guard/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /increment counter/);
});

test("a comment-free write is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/nonexistent/a.js", content: "const x = 1;\n" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a jsdoc type tag block is exempt from the comment guard", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/a.js",
      content: "/**\n * @param {number} n\n */\nfunction f(n) { return n; }\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an edit that only moves an existing comment is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: "/nonexistent/a.ts",
      old_string: "// keep this note\nconst a = 1;",
      new_string: "const a = 2;\n// keep this note",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an edit introducing a hash comment in python is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: "/nonexistent/a.py",
      old_string: "x = 1",
      new_string: "# loop over users\nx = 1",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("the comment guard ignores non-code files and bad payloads", () => {
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/n/a.md", content: "# heading\ntext" } },
    { tool_name: "Bash", tool_input: { command: "echo // hi" } },
    { tool_name: "Write", tool_input: {} },
  ]) {
    const processResult = runHook("block-comments.mjs", payload);
    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  }
});

test("a shebang line does not count as a comment", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/nonexistent/run.sh", content: "#!/bin/sh\nset -e\n" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a shell heredoc body carrying a hash line is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/gen.sh",
      content: "cat <<'EOF'\n# generated file\nEOF\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a python docstring carrying a hash line is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/a.py",
      content: 'def f():\n    """\n    # Usage: f()\n    """\n    return 1\n',
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a template literal carrying a slash line is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/a.js",
      content: "const banner = `\n// not a comment\n`;\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a write to an unreadable existing file is allowed", (testContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "a.js");
  const content = "// existing note\nconst a = 1;\n";
  try {
    fs.writeFileSync(filePath, content, "utf8");
    fs.chmodSync(filePath, 0o000);
    if (canRead(filePath)) {
      testContext.skip("this account reads a mode 000 file");
      return;
    }

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.chmodSync(filePath, 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prose block comment holding an email address is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/a.js",
      content: "/**\n * ping alice@example.com before touching this\n */\nconst a = 1;\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /alice@example\.com/);
});

test("the deny reason names only the comment the edit adds", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: "/nonexistent/a.js",
      old_string: "// keep a\n// keep b\nconst a = 1;",
      new_string: "// keep a\n// keep b\n// brand new\nconst a = 1;",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /brand new/);
  assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /keep a/);
});

test("a shell left shift does not open a heredoc region", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/shift.sh",
      content: "mask=$(( 1 << 3 ))\n# explain the mask\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the mask/);
});

test("a herestring does not open a heredoc region", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/here.sh",
      content: "cat <<< hello\n# explain the greeting\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the greeting/);
});

test("a backtick inside a quoted string does not open a template literal", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/quote.js",
      content: 'const fence = "`";\n// explain the fence\n',
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the fence/);
});

test("a triple quote inside a quoted string does not open a docstring", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/quote.py",
      content: "token = \"'''\"\n# explain the token\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the token/);
});

test("an edit inside a heredoc body of an on-disk file is allowed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "gen.sh");
  try {
    fs.writeFileSync(filePath, "cat <<'EOF'\nintro line\nEOF\nrun_it\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: {
        file_path: filePath,
        old_string: "intro line",
        new_string: "intro line\n# generated by hand",
      },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an edit outside the heredoc body of an on-disk file is denied", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "gen.sh");
  try {
    fs.writeFileSync(filePath, "cat <<'EOF'\nintro line\nEOF\nrun_it\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: {
        file_path: filePath,
        old_string: "run_it",
        new_string: "# explain the run\nrun_it",
      },
    });

    assert.equal(processResult.status, 0);
    const output = JSON.parse(processResult.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the run/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a yaml block scalar carrying a hash line is not gated", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/workflow.yml",
      content: "jobs:\n  build:\n    run: |\n      # release notes\n      make all\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a long whitespace run in a block comment is judged quickly", () => {
  const content = `/**\n${" ".repeat(20000)}prose about the module\n */\nconst a = 1;\n`;
  const startedAt = performance.now();
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/nonexistent/slow.js", content },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(elapsedMs < 500, `hook took ${elapsedMs}ms`);
});

test("an apostrophe inside a template literal does not hide later comments", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/message.js",
      content: "const msg = `Can't find ${name}`;\n// brand new note\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /brand new note/);
});

test("deleting a template literal line above existing comments is allowed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "message.js");
  const templateLine = "const msg = `Can't find ${name}`;\n";
  try {
    fs.writeFileSync(filePath, `${templateLine}// one\n// two\n// three\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: templateLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a shift operator inside a quoted string does not open a heredoc", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "echo.sh");
  const echoLine = 'echo "use << HERE for input"\n';
  try {
    fs.writeFileSync(filePath, `${echoLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: echoLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a backslash-escaped heredoc delimiter opens a body", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/gen.sh",
      content: "cat <<\\EOF\n# generated file\nEOF\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("two heredocs opened on one line both keep their bodies out of the count", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/pair.sh",
      content: "cat <<FIRST <<SECOND\nFIRST\n# second body\nSECOND\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a backtick in a trailing comment does not open a template literal", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/tail.js",
      content: "const count = 1; // `\n// explain the count\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the count/);
});

test("an escaped triple quote does not close a docstring", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/doc.py",
      content: 'x = """\n\\"""\n# still text\n"""\n',
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("the deny reason omits an on-disk line the call never supplied", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "settings.py");
  try {
    fs.writeFileSync(filePath, "x = 1\nSECRET = 1\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: "\n", new_string: "\n#" },
    });

    assert.equal(processResult.status, 0);
    const output = JSON.parse(processResult.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /1 net-new comment line/);
    assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /SECRET/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deleting a line whose trailing comment names a heredoc opener is allowed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "echo.sh");
  const callLine = "run_it # see << HERE\n";
  try {
    fs.writeFileSync(filePath, `${callLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: callLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a heredoc opener inside a trailing shell comment does not hide a new comment", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/tail.sh",
      content: "echo ok # <<EOF\n# explain the echo\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the echo/);
});

test("a positional parameter count still opens a heredoc region", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/args.sh",
      content: "[ $# -gt 0 ] && cat <<EOF\n# generated file\nEOF\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("deleting a line whose trailing comment holds a triple quote is allowed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "settings.py");
  const assignmentLine = 'x = 1  # use """ here\n';
  try {
    fs.writeFileSync(filePath, `${assignmentLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: assignmentLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a triple quote inside a trailing python comment does not open a docstring", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/tail.py",
      content: "value = 1 # '''\n# explain the value\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the value/);
});

test("deleting a tag line from a jsdoc block is allowed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-hook-"));
  const filePath = path.join(directory, "doc.js");
  const tagLine = " * @param {number} n\n";
  try {
    fs.writeFileSync(
      filePath,
      `/**\n * describes f\n${tagLine} */\nfunction f(n) { return n; }\n`,
      "utf8",
    );

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: tagLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a single-line jsdoc type cast is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/cast.js",
      content: "/** @type {Foo} */\nconst a = load();\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("prose lines in a tagged jsdoc block are denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/prose.js",
      content:
        "/**\n * @param {number} n\n * smuggled prose one\n * smuggled prose two\n */\nfunction f(n) { return n; }\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /2 net-new comment line/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /smuggled prose one/);
});

test("a backtick inside a same-line block comment does not open a template literal", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: "/nonexistent/inline.js",
      content: "const count = 1; /* ` */\n// explain the count\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the count/);
});
