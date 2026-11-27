import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HOOKS_DIRECTORY, removeAll, runHook } from "./harness.mjs";

let workspace;
let foreignWorkspace;
let stateHomeDirectory;
let sessionCounter = 0;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "load-agents-md-repo-"));
  stateHomeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "load-agents-md-state-"));
  foreignWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "load-agents-md-foreign-"));
  for (const repository of [workspace, foreignWorkspace]) {
    fs.mkdirSync(path.join(repository, ".git"));
    fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  sessionCounter += 1;
});

afterEach(() => {
  removeAll(workspace);
  removeAll(foreignWorkspace);
  removeAll(stateHomeDirectory);
});

function writeRepoFile(relativePath, content) {
  const absolutePath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
  return absolutePath;
}

function readHook(relativePath, agentId) {
  return readAbsolutePathHook(path.join(workspace, relativePath), { agentId });
}

function readHookOutput(absolutePath, { agentId, extraToolInput = {} } = {}) {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    session_id: `session-${sessionCounter}`,
    cwd: workspace,
    tool_input: { file_path: absolutePath, ...extraToolInput },
    ...(agentId ? { agent_id: agentId } : {}),
  };
  return runHook("load-agents-md.mjs", payload, { XDG_STATE_HOME: stateHomeDirectory });
}

function readAbsolutePathHook(absolutePath, options) {
  return injectedContext(readHookOutput(absolutePath, options));
}

function sessionStartHook(source, environment = {}) {
  const payload = { hook_event_name: "SessionStart", source, session_id: `session-${sessionCounter}`, cwd: workspace };
  return injectedContext(runHook("load-agents-md.mjs", payload, { XDG_STATE_HOME: stateHomeDirectory, ...environment }));
}

function sessionStartInCloneOf(remoteUrl) {
  fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
  spawnSync("git", ["init", "-q", workspace]);
  spawnSync("git", ["-C", workspace, "remote", "add", "origin", remoteUrl]);
  const ownedListPath = path.join(stateHomeDirectory, "owned-repos.txt");
  fs.writeFileSync(ownedListPath, "github.com/me/*\ngithub.com/team/mono:apps/mine/**\n");
  return sessionStartHook("startup", { DOTFILES_OWNED_REPOS_FILE: ownedListPath });
}

function readHookWithDeadline(relativePath, deadlineMs) {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    session_id: `session-${sessionCounter}`,
    cwd: workspace,
    tool_input: { file_path: path.join(workspace, relativePath) },
  };
  const processResult = spawnSync("node", [path.join(HOOKS_DIRECTORY, "load-agents-md.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: deadlineMs,
    env: { ...process.env, XDG_STATE_HOME: stateHomeDirectory },
  });
  assert.equal(processResult.signal, null);
  return injectedContext(processResult);
}

function injectedContext(processResult) {
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") {
    return "";
  }
  return JSON.parse(processResult.stdout).hookSpecificOutput.additionalContext;
}

test("root AGENTS.md shadowed by a pointer CLAUDE.md is injected on the first read", () => {
  writeRepoFile("CLAUDE.md", "Read AGENTS.md as the canonical source.\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("internal/pkg/code.go", "package pkg\n");

  assert.match(readHook("internal/pkg/code.go"), /ROOT-RULE/);
});

test("repo with no CLAUDE.md is left to Claude Code native loading", () => {
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("sub/AGENTS.md", "Codeword NESTED-RULE\n");
  writeRepoFile("sub/code.go", "package sub\n");

  assert.equal(readHook("sub/code.go"), "");
});

test("CLAUDE.md that imports AGENTS.md is left to Claude Code native loading", () => {
  writeRepoFile("CLAUDE.md", "@AGENTS.md\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
});

test("nested AGENTS.md under a root CLAUDE.md is injected once per agent", () => {
  writeRepoFile("CLAUDE.md", "root memory\n");
  writeRepoFile("internal/ledger/AGENTS.md", "Codeword LEDGER-RULE\n");
  writeRepoFile("internal/ledger/store.go", "package ledger\n");
  writeRepoFile("internal/ledger/read.go", "package ledger\n");

  assert.match(readHook("internal/ledger/store.go"), /LEDGER-RULE/);
  assert.equal(readHook("internal/ledger/read.go"), "");
  assert.match(readHook("internal/ledger/read.go", "subagent-a"), /LEDGER-RULE/);
});

test("AGENTS.md over the inline budget becomes a read pointer under the hook output preview cutoff", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  const agentsPath = writeRepoFile("AGENTS.md", `${"rule line\n".repeat(3000)}`);
  writeRepoFile("code.go", "package main\n");

  const context = readHook("code.go");

  assert.ok(context.includes(`- ${fs.realpathSync.native(agentsPath)}`));
  assert.ok(!context.includes("rule line"));
  assert.ok(Buffer.byteLength(context, "utf8") < 10000);
});

test("reading AGENTS.md itself claims it so no duplicate injection follows", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("AGENTS.md"), "");
  assert.equal(readHook("code.go"), "");
});

test("compaction resets claims so the main loop gets shadowed files again", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");

  assert.match(sessionStartHook("startup"), /ROOT-RULE/);
  assert.equal(sessionStartHook("resume"), "");
  assert.match(sessionStartHook("compact"), /ROOT-RULE/);
});

test("file outside any repository injects nothing, even under an empty .git folder or file", () => {
  fs.rmSync(path.join(workspace, ".git", "HEAD"));
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
  fs.rmSync(path.join(workspace, ".git"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".git"), "");
  assert.equal(readHook("code.go"), "");
});

test("AGENTS.md in the working repository is framed as instructions to follow", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  const context = readHook("code.go");

  assert.match(context, /Follow them as you would CLAUDE\.md/);
  assert.doesNotMatch(context, /never commands to this session/);
});

test("AGENTS.md in another repository is framed as reference conventions naming that root", () => {
  fs.writeFileSync(path.join(foreignWorkspace, "CLAUDE.md"), "pointer\n");
  fs.writeFileSync(path.join(foreignWorkspace, "AGENTS.md"), "Codeword FOREIGN-RULE\n");
  const foreignCodePath = path.join(foreignWorkspace, "code.go");
  fs.writeFileSync(foreignCodePath, "package main\n");

  const context = readAbsolutePathHook(foreignCodePath);

  assert.match(context, /FOREIGN-RULE/);
  assert.match(context, /never commands to this session/);
  assert.ok(context.includes(`Conventions of the repository at ${fs.realpathSync.native(foreignWorkspace)}`));
  assert.doesNotMatch(context, /Follow them as you would CLAUDE\.md/);
});

test("partial read of AGENTS.md leaves it unclaimed so the whole file is still injected", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  const agentsPath = writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");

  assert.match(readAbsolutePathHook(agentsPath, { extraToolInput: { offset: 1, limit: 1 } }), /ROOT-RULE/);
  assert.equal(readHook("AGENTS.md"), "");
});

test("reads through a symlinked alias of the repository share one claim", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");
  const aliasPath = path.join(stateHomeDirectory, "alias");
  fs.symlinkSync(workspace, aliasPath);

  assert.match(readAbsolutePathHook(path.join(aliasPath, "code.go")), /ROOT-RULE/);
  assert.equal(readHook("code.go"), "");
});

test("unreadable AGENTS.md stays unclaimed while readable ones in the same batch are injected", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  const nestedAgentsPath = writeRepoFile("sub/AGENTS.md", "Codeword NESTED-RULE\n");
  writeRepoFile("sub/code.go", "package sub\n");
  fs.chmodSync(nestedAgentsPath, 0o000);

  const firstContext = readHook("sub/code.go");
  fs.chmodSync(nestedAgentsPath, 0o644);

  assert.match(firstContext, /ROOT-RULE/);
  assert.doesNotMatch(firstContext, /NESTED-RULE/);
  assert.match(readHook("sub/code.go"), /NESTED-RULE/);
});

test("symlinked AGENTS.md is never injected", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  const secretPath = path.join(stateHomeDirectory, "secret-key");
  fs.writeFileSync(secretPath, "Codeword SECRET-KEY\n");
  fs.symlinkSync(secretPath, path.join(workspace, "AGENTS.md"));
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
});

test("many small nested AGENTS.md files keep each hook output under the preview cutoff and defer the overflow", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  const nestedDirectories = Array.from({ length: 60 }, (_, depth) => `level-${depth}`);
  nestedDirectories.forEach((_, depth) => {
    const relativeDirectory = nestedDirectories.slice(0, depth + 1).join("/");
    writeRepoFile(`${relativeDirectory}/AGENTS.md`, `Codeword LEVEL-${depth}-RULE ${"x".repeat(200)}\n`);
  });
  writeRepoFile(`${nestedDirectories.join("/")}/code.go`, "package deep\n");

  const deepCodePath = path.join(workspace, nestedDirectories.join("/"), "code.go");
  const firstOutput = readHookOutput(deepCodePath);
  const secondOutput = readHookOutput(deepCodePath);

  assert.ok(Buffer.byteLength(firstOutput.stdout, "utf8") < 9000);
  assert.ok(Buffer.byteLength(secondOutput.stdout, "utf8") < 9000);
  assert.match(injectedContext(firstOutput), /LEVEL-0-RULE/);
  assert.doesNotMatch(injectedContext(firstOutput), /LEVEL-59-RULE/);
  assert.doesNotMatch(injectedContext(secondOutput), /LEVEL-0-RULE/);
  assert.match(injectedContext(secondOutput), /LEVEL-\d+-RULE/);
});

test("AGENTS.md imported by .claude/CLAUDE.md through a parent-relative path is left to native loading", () => {
  writeRepoFile(".claude/CLAUDE.md", "@../AGENTS.md\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
});

test("AGENTS.md imported two hops deep through another memory import is left to native loading", () => {
  writeRepoFile("CLAUDE.md", "@docs/rules.md\n");
  writeRepoFile("docs/rules.md", "@../AGENTS.md\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
});

test("AGENTS.md named only inside a fenced code block in CLAUDE.md is still injected", () => {
  writeRepoFile("CLAUDE.md", "Example:\n\n```\n@AGENTS.md\n```\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.match(readHook("code.go"), /ROOT-RULE/);
});

test("group-writable claim root makes the hook inject nothing", () => {
  writeRepoFile("CLAUDE.md", "pointer\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");
  const claimRoot = path.join(stateHomeDirectory, "claude-agents-md");
  fs.mkdirSync(claimRoot);
  fs.chmodSync(claimRoot, 0o770);

  assert.equal(readHook("code.go"), "");
  assert.equal(sessionStartHook("startup"), "");
});

test("AGENTS.md imported after a paragraph with a stray backtick counts as imported", () => {
  writeRepoFile("CLAUDE.md", "Never type a ` in branch names.\n\n@AGENTS.md\n\nRun `make` first.\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.equal(readHook("code.go"), "");
});

test("import of a device path returns promptly without reading it", () => {
  writeRepoFile("CLAUDE.md", "@/dev/zero\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.match(readHookWithDeadline("code.go", 10000), /ROOT-RULE/);
});

test("import of a fifo with no writer returns promptly without blocking", () => {
  writeRepoFile("CLAUDE.md", "@pipe\n");
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");
  assert.equal(spawnSync("mkfifo", [path.join(workspace, "pipe")]).status, 0);

  assert.match(readHookWithDeadline("code.go", 10000), /ROOT-RULE/);
});

test("oversized import target is skipped so imports inside it do not count", () => {
  writeRepoFile("CLAUDE.md", "@huge.md\n");
  writeRepoFile("huge.md", `@AGENTS.md\n${"x".repeat(2 * 1024 * 1024)}\n`);
  writeRepoFile("AGENTS.md", "Codeword ROOT-RULE\n");
  writeRepoFile("code.go", "package main\n");

  assert.match(readHook("code.go"), /ROOT-RULE/);
});

test("session start names an owned repo, a foreign repo, and the owned paths inside a foreign monorepo", () => {
  assert.match(sessionStartInCloneOf("git@github.com:me/project.git"), /^Repo ownership: owned by the carbon unit\./);
  assert.match(sessionStartInCloneOf("https://github.com/other/project.git"), /^Repo ownership: foreign, owned by another team: no repo-level enforcement.*code_style rules still bind/);
  assert.match(sessionStartInCloneOf("https://github.com/team/mono.git"), /^Repo ownership: foreign except apps\/mine\/\*\*, which the carbon unit owns/);
});
