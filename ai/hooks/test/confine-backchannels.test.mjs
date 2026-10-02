import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

function temporaryDirectory(testContext, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function initializeRepository(repository, originUrl) {
  fs.mkdirSync(repository, { recursive: true });
  spawnSync("git", ["init", "-q", repository]);
  spawnSync("git", ["-C", repository, "remote", "add", "origin", originUrl]);
  spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  return repository;
}

function homeWithBackchannelClone(testContext) {
  const homeDirectory = temporaryDirectory(testContext, "confine-backchannels-home-");
  const backchannelClone = initializeRepository(
    path.join(homeDirectory, "Projects", "backchannel"),
    "https://github.com/johncwaters/backchannels.git",
  );
  return { homeDirectory, backchannelClone };
}

function repositoryWithOrigin(testContext, originUrl) {
  return initializeRepository(path.join(temporaryDirectory(testContext, "confine-backchannels-repo-"), "repo"), originUrl);
}

function decisionFor(payload, homeDirectory) {
  const processResult = runHook("confine-backchannels.mjs", payload, { HOME: homeDirectory });
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") return "allow";
  return JSON.parse(processResult.stdout).hookSpecificOutput.permissionDecision;
}

function sessionStartOutput(cwd, homeDirectory) {
  const processResult = runHook("confine-backchannels.mjs", { hook_event_name: "SessionStart", source: "startup", cwd }, { HOME: homeDirectory });
  assert.equal(processResult.status, 0);
  return processResult.stdout;
}

const BACKCHANNELS_CALLS = [
  { hook_event_name: "PreToolUse", tool_name: "mcp__backchannels__register_agent", tool_input: { name: "agent" } },
  { hook_event_name: "PreToolUse", tool_name: "mcp__backchannels__send_message", tool_input: { body: "hi" } },
  { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "backchannels" } },
  { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "/backchannels" } },
  { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: " backchannels " } },
  { hook_event_name: "PreToolUse", tool_name: "ListMcpResourcesTool", tool_input: { server: "backchannels" } },
  { hook_event_name: "PreToolUse", tool_name: "ReadMcpResourceTool", tool_input: { server: "backchannels", uri: "backchannels://inbox" } },
];

function workspaceWithChildren(testContext, originUrlsByChildName) {
  const workspaceDirectory = temporaryDirectory(testContext, "confine-backchannels-workspace-");
  fs.writeFileSync(path.join(workspaceDirectory, "AGENTS.md"), "");
  fs.mkdirSync(path.join(workspaceDirectory, ".claude"));
  for (const [childName, originUrl] of Object.entries(originUrlsByChildName)) {
    initializeRepository(path.join(workspaceDirectory, childName), originUrl);
  }
  return workspaceDirectory;
}

test("backchannels tools and skill are denied in a personal repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  for (const call of BACKCHANNELS_CALLS) {
    assert.equal(decisionFor({ ...call, cwd: personalRepository }, homeDirectory), "deny", JSON.stringify(call));
  }
});

test("backchannels tools and skill are allowed in PostHog repositories over https and ssh", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  for (const originUrl of ["https://github.com/PostHog/posthog.git", "git@github.com:PostHog/ai-gateway.git", "ssh://git@github.com/PostHog/wizard.git"]) {
    const workRepository = repositoryWithOrigin(testContext, originUrl);
    for (const call of BACKCHANNELS_CALLS) {
      assert.equal(decisionFor({ ...call, cwd: workRepository }, homeDirectory), "allow", `${originUrl} ${JSON.stringify(call)}`);
    }
  }
});

test("backchannels is allowed in the backchannel clone and its worktrees", (testContext) => {
  const { homeDirectory, backchannelClone } = homeWithBackchannelClone(testContext);
  const worktree = path.join(temporaryDirectory(testContext, "confine-backchannels-worktrees-"), "backchannel-feature");
  const worktreeResult = spawnSync("git", ["-C", backchannelClone, "worktree", "add", "-q", "-b", "feature", worktree]);
  assert.equal(worktreeResult.status, 0);
  for (const cwd of [backchannelClone, worktree]) {
    assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd }, homeDirectory), "allow", cwd);
  }
});

test("a directory outside any repository denies backchannels", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const plainDirectory = temporaryDirectory(testContext, "confine-backchannels-plain-");
  assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: plainDirectory }, homeDirectory), "deny");
});

test("a failed confinement check denies backchannels and allows other calls", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const missingDirectory = path.join(temporaryDirectory(testContext, "confine-backchannels-missing-"), "does-not-exist");
  assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: missingDirectory }, homeDirectory), "deny");
  const otherCall = { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "commit" }, cwd: missingDirectory };
  assert.equal(decisionFor(otherCall, homeDirectory), "allow");
});

test("an origin that only mentions github.com/PostHog on another host denies backchannels", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  for (const originUrl of ["https://evil.example/mirror/github.com/posthog/x", "git@evil.example:github.com/PostHog/x"]) {
    const spoofedRepository = repositoryWithOrigin(testContext, originUrl);
    assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: spoofedRepository }, homeDirectory), "deny", originUrl);
  }
});

test("a workspace folder of PostHog child repositories allows backchannels and stays silent at session start", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const workspaceDirectory = workspaceWithChildren(testContext, {
    wizard: "https://github.com/PostHog/wizard.git",
    "wizard-workbench": "git@github.com:PostHog/wizard-workbench.git",
  });
  for (const call of BACKCHANNELS_CALLS) {
    assert.equal(decisionFor({ ...call, cwd: workspaceDirectory }, homeDirectory), "allow", JSON.stringify(call));
  }
  assert.equal(sessionStartOutput(workspaceDirectory, homeDirectory), "");
});

test("a workspace folder with a personal child repository denies backchannels and announces the skip", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const workspaceDirectory = workspaceWithChildren(testContext, {
    wizard: "https://github.com/PostHog/wizard.git",
    dotfiles: "https://github.com/johncwaters/dotfiles",
  });
  assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: workspaceDirectory }, homeDirectory), "deny");
  assert.match(sessionStartOutput(workspaceDirectory, homeDirectory), /backchannels is off here/);
});

test("other tools and skills pass untouched in a personal repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  for (const call of [
    { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "commit" } },
    { hook_event_name: "PreToolUse", tool_name: "mcp__plugin_posthog_posthog__exec", tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
    { hook_event_name: "PreToolUse", tool_name: "ListMcpResourcesTool", tool_input: { server: "posthog" } },
    { hook_event_name: "PreToolUse", tool_name: "ReadMcpResourceTool", tool_input: { server: "posthog", uri: "posthog://docs" } },
  ]) {
    assert.equal(decisionFor({ ...call, cwd: personalRepository }, homeDirectory), "allow", JSON.stringify(call));
  }
});

test("session start tells a personal-repo session to skip backchannels", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/glimmervoid");
  assert.match(sessionStartOutput(personalRepository, homeDirectory), /backchannels is off here/);
});

test("session start stays silent in a work repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const workRepository = repositoryWithOrigin(testContext, "https://github.com/PostHog/posthog.git");
  assert.equal(sessionStartOutput(workRepository, homeDirectory), "");
});

test("a malformed payload is allowed", () => {
  const processResult = spawnSync("node", [path.join(import.meta.dirname, "..", "confine-backchannels.mjs")], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});
