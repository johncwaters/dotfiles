import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "../../../../ai/hooks/test/harness.mjs";

const HOOK_PATH = path.join(import.meta.dirname, "..", "require-worktree.mjs");
const scratchDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "require-worktree-")));
const mainCheckout = path.join(scratchDirectory, "repo");
const sessionWorktree = path.join(scratchDirectory, "session-worktree");
const otherWorktree = path.join(scratchDirectory, "other-worktree");
const git = (...gitArguments) => spawnSync("git", gitArguments, { encoding: "utf8" });
git("init", "-q", "-b", "main", mainCheckout);
git("-C", mainCheckout, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "root");
git("-C", mainCheckout, "worktree", "add", "-q", sessionWorktree, "-b", "session");
git("-C", mainCheckout, "worktree", "add", "-q", otherWorktree, "-b", "other");
const library = path.join(scratchDirectory, "library");
git("init", "-q", "-b", "main", library);
git("-C", library, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "root");
git("-C", sessionWorktree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "library");
fs.writeFileSync(path.join(mainCheckout, "README.md"), "x\n");
fs.mkdirSync(path.join(scratchDirectory, "home"));
fs.symlinkSync(path.join(mainCheckout, "README.md"), path.join(scratchDirectory, "home", "linked.md"));

function decisionOf(payload, hookArguments = []) {
  const hookProcess = runHook(HOOK_PATH, payload, {}, process.cwd(), hookArguments);
  assert.equal(hookProcess.status, 0);
  if (!hookProcess.stdout) return { decision: "allow", reason: "" };
  const reply = JSON.parse(hookProcess.stdout);
  if (reply.decision) return { decision: reply.decision, reason: reply.reason };
  return { decision: reply.hookSpecificOutput.permissionDecision, reason: reply.hookSpecificOutput.permissionDecisionReason };
}

const writeIn = (cwd, filePath) => ({ tool_name: "Write", cwd, tool_input: { file_path: filePath, content: "x\n" } });

test("an edit in a repo's main checkout is denied, even from a session inside it", () => {
  for (const cwd of [mainCheckout, sessionWorktree, scratchDirectory]) {
    const { decision, reason } = decisionOf(writeIn(cwd, path.join(mainCheckout, "src", "new.ts")));
    assert.equal(decision, "deny", cwd);
    assert.match(reason, /main checkout/);
  }
  assert.equal(decisionOf(writeIn(sessionWorktree, path.join(scratchDirectory, "home", "linked.md"))).decision, "deny");
});

test("an edit in another worktree of the session's repo is denied", () => {
  const { decision, reason } = decisionOf(writeIn(sessionWorktree, path.join(otherWorktree, "a.ts")));
  assert.equal(decision, "deny");
  assert.match(reason, new RegExp(`works in ${sessionWorktree}`));
});

test("edits in the session's own worktree, from the main checkout into a worktree, or outside git pass", () => {
  assert.equal(decisionOf(writeIn(sessionWorktree, path.join(sessionWorktree, "a.ts"))).decision, "allow");
  assert.equal(decisionOf(writeIn(sessionWorktree, "relative/a.ts")).decision, "allow");
  assert.equal(decisionOf(writeIn(mainCheckout, path.join(sessionWorktree, "a.ts"))).decision, "allow");
  assert.equal(decisionOf(writeIn(sessionWorktree, path.join(scratchDirectory, "loose", "notes.md"))).decision, "allow");
  assert.equal(decisionOf(writeIn(sessionWorktree, path.join(sessionWorktree, "library", "x.ts"))).decision, "allow");
  const inheritedGitDirectory = runHook(HOOK_PATH, writeIn(sessionWorktree, path.join(scratchDirectory, "loose", "notes.md")), { GIT_DIR: path.join(mainCheckout, ".git") });
  assert.equal(inheritedGitDirectory.stdout, "");
  assert.equal(decisionOf({ tool_name: "Bash", cwd: mainCheckout, tool_input: { command: "ls" } }).decision, "allow");
});

test("an agy write into a main checkout is denied in agy's reply shape", () => {
  const agyWrite = { hookEventName: "PreToolUse", conversationId: "agy-conversation", toolCall: { name: "write_file", args: { Path: path.join(mainCheckout, "a.ts"), Content: "x" } } };
  assert.equal(decisionOf(agyWrite, ["--agent=agy"]).decision, "deny");
});
