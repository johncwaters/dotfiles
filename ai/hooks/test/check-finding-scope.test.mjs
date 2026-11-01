import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gitOutput } from "../../skills/landing/test/helpers.ts";
import { makeRepository, runHook } from "./harness.mjs";

function findingAt(filePath, line, side) {
  return [
    "STRUCTURED_FINDINGS:",
    `- file: ${filePath} | line: ${line} | side: ${side} | severity: LOW | reviewer: code/logic | body: example`,
    "",
    "OVERALL_SUMMARY:",
    "Example summary.",
  ].join("\n");
}

function findingsFor(filePath) {
  return findingAt(filePath, 1, "RIGHT");
}

function makeMultiLineRepository() {
  return makeRepository("one\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfive\n");
}

function scopeContextFor(repository, toolResponse) {
  const processResult = runHook("check-finding-scope.mjs", {
    cwd: repository,
    tool_name: "Agent",
    tool_response: toolResponse,
  });
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") {
    return "";
  }
  return JSON.parse(processResult.stdout).hookSpecificOutput.additionalContext;
}

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

test("finding scope warns for a changed file when the line is outside every hunk", () => {
  const repository = makeMultiLineRepository();
  try {
    assert.equal(scopeContextFor(repository, findingAt("a.txt", 3, "RIGHT")), "");
    assert.equal(scopeContextFor(repository, findingAt("a.txt", 4, "LEFT")), "");
    assert.equal(scopeContextFor(repository, findingAt("a.txt", "general", "RIGHT")), "");

    const unchangedLineContext = scopeContextFor(repository, findingAt("a.txt", 1, "RIGHT"));
    assert.match(unchangedLineContext, /lines the diff did not change: a\.txt:1 \(RIGHT\)/);
    assert.doesNotMatch(unchangedLineContext, /outside the current diff/);

    const wrongSideContext = scopeContextFor(repository, findingAt("a.txt", 4, "RIGHT"));
    assert.match(wrongSideContext, /a\.txt:4 \(RIGHT\)/);

    fs.writeFileSync(path.join(repository, "new.txt"), "a\nb\nc\n", "utf8");
    assert.equal(scopeContextFor(repository, findingAt("new.txt", 3, "RIGHT")), "");
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("finding scope reports out-of-diff files and unchanged lines together", () => {
  const repository = makeMultiLineRepository();
  try {
    const context = scopeContextFor(repository, [
      "STRUCTURED_FINDINGS:",
      "- file: b.txt | line: 1 | side: RIGHT | severity: LOW | reviewer: code/logic | body: x",
      "- file: a.txt | line: 5 | side: RIGHT | severity: LOW | reviewer: code/logic | body: y",
      "- file: a.txt | line: 3 | side: RIGHT | severity: LOW | reviewer: code/logic | body: z",
      "",
      "OVERALL_SUMMARY:",
    ].join("\n"));
    assert.match(context, /outside the current diff: b\.txt\./);
    assert.match(context, /did not change: a\.txt:5 \(RIGHT\)\./);
    assert.doesNotMatch(context, /a\.txt:3/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("a deletion-only hunk anchors nothing on the right side", () => {
  const repository = makeRepository("one\ntwo\nthree\nfour\nfive\n", "one\nfour\nfive\n");
  try {
    assert.equal(scopeContextFor(repository, findingAt("a.txt", 2, "LEFT")), "");
    assert.equal(scopeContextFor(repository, findingAt("a.txt", 3, "LEFT")), "");
    assert.match(
      scopeContextFor(repository, findingAt("a.txt", 1, "RIGHT")),
      /did not change: a\.txt:1 \(RIGHT\)/,
    );
    assert.match(
      scopeContextFor(repository, findingAt("a.txt", 2, "RIGHT")),
      /did not change: a\.txt:2 \(RIGHT\)/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("an insertion-only hunk anchors nothing on the left side", () => {
  const repository = makeRepository("one\ntwo\nthree\n", "one\ntwo\nNEW\nthree\n");
  try {
    assert.equal(scopeContextFor(repository, findingAt("a.txt", 3, "RIGHT")), "");
    assert.match(
      scopeContextFor(repository, findingAt("a.txt", 2, "LEFT")),
      /did not change: a\.txt:2 \(LEFT\)/,
    );
    assert.match(
      scopeContextFor(repository, findingAt("a.txt", 3, "LEFT")),
      /did not change: a\.txt:3 \(LEFT\)/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("an external diff driver does not turn a changed line into an unchanged one", () => {
  const repository = makeMultiLineRepository();
  try {
    const driverPath = path.join(repository, "diff-driver.sh");
    fs.writeFileSync(driverPath, "#!/bin/sh\necho 'files differ'\n", "utf8");
    fs.chmodSync(driverPath, 0o755);
    gitOutput(repository, ["config", "diff.external", driverPath]);

    assert.equal(scopeContextFor(repository, findingAt("a.txt", 3, "RIGHT")), "");
    assert.match(
      scopeContextFor(repository, findingAt("a.txt", 1, "RIGHT")),
      /lines the diff did not change: a\.txt:1 \(RIGHT\)/,
    );
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
