import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "../../../../ai/hooks/test/harness.mjs";

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
  const processResult = runHook(path.join(import.meta.dirname, "..", "confine-backchannels.mjs"), payload, { HOME: homeDirectory });
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") return "allow";
  return JSON.parse(processResult.stdout).hookSpecificOutput.permissionDecision;
}

function sessionStartOutput(cwd, homeDirectory) {
  const processResult = runHook(path.join(import.meta.dirname, "..", "confine-backchannels.mjs"), { hook_event_name: "SessionStart", source: "startup", cwd }, { HOME: homeDirectory });
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
  { hook_event_name: "PreToolUse", tool_name: "list_mcp_resources", tool_input: { server: "backchannels" } },
  { hook_event_name: "PreToolUse", tool_name: "list_mcp_resource_templates", tool_input: { server: "backchannels" } },
  { hook_event_name: "PreToolUse", tool_name: "read_mcp_resource", tool_input: { server: "backchannels", uri: "backchannels://inbox" } },
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

test("the declared backchannels origin permits the plural clone and its worktrees", (testContext) => {
  const homeDirectory = temporaryDirectory(testContext, "declared-backchannels-home-");
  const cloneDirectory = initializeRepository(path.join(homeDirectory, "Projects", "backchannels"), "https://github.com/johncwaters/backchannels");
  const worktreeDirectory = path.join(homeDirectory, "feature");
  const worktreeProcess = spawnSync("git", ["-C", cloneDirectory, "worktree", "add", "-q", "-b", "feature", worktreeDirectory]);
  assert.equal(worktreeProcess.status, 0);
  for (const cwd of [cloneDirectory, worktreeDirectory]) {
    assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd }, homeDirectory), "allow");
    assert.equal(sessionStartOutput(cwd, homeDirectory), "");
  }
});

test("the declared repository origin accepts HTTPS and SSH but denies other owners, repos and hosts", (testContext) => {
  const homeDirectory = temporaryDirectory(testContext, "declared-backchannels-origins-");
  for (const originUrl of ["https://github.com/johncwaters/backchannels.git", "git@github.com:johncwaters/backchannels.git", "ssh://git@github.com/johncwaters/backchannels"]) {
    assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: repositoryWithOrigin(testContext, originUrl) }, homeDirectory), "allow", originUrl);
  }
  for (const originUrl of ["https://github.com/someoneelse/backchannels", "https://github.com/johncwaters/backchannels-fork", "https://evil.example/johncwaters/backchannels", "https://github.com/johncwaters/glimmervoid", "https://github.com/johncwaters/dotfiles"]) {
    assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: repositoryWithOrigin(testContext, originUrl) }, homeDirectory), "deny", originUrl);
  }
});

test("a failed confinement check denies backchannels and allows other calls", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const missingDirectory = path.join(temporaryDirectory(testContext, "confine-backchannels-missing-"), "does-not-exist");
  assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: missingDirectory }, homeDirectory), "deny");
  const otherCall = { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "committing" }, cwd: missingDirectory };
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

test("a workspace folder with more children than the scan cap denies backchannels", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const workspaceDirectory = workspaceWithChildren(testContext, { wizard: "https://github.com/PostHog/wizard.git" });
  for (let childIndex = 0; childIndex < 64; childIndex += 1) {
    fs.mkdirSync(path.join(workspaceDirectory, `notes-${childIndex}`));
  }
  assert.equal(decisionFor({ ...BACKCHANNELS_CALLS[0], cwd: workspaceDirectory }, homeDirectory), "deny");
  assert.match(sessionStartOutput(workspaceDirectory, homeDirectory), /backchannels is off here/);
});

test("resource tools without a server fan out to backchannels, so they are denied in a personal repository and allowed in a work repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  const workRepository = repositoryWithOrigin(testContext, "https://github.com/PostHog/posthog.git");
  const serverlessResourceCalls = ["ListMcpResourcesTool", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].flatMap((toolName) => [
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { server: " " } },
  ]);
  for (const call of serverlessResourceCalls) {
    assert.equal(decisionFor({ ...call, cwd: personalRepository }, homeDirectory), "deny", JSON.stringify(call));
    assert.equal(decisionFor({ ...call, cwd: workRepository }, homeDirectory), "allow", JSON.stringify(call));
  }
});

test("other tools and skills pass untouched in a personal repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  for (const call of [
    { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "committing" } },
    { hook_event_name: "PreToolUse", tool_name: "mcp__posthog__exec", tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
    { hook_event_name: "PreToolUse", tool_name: "ListMcpResourcesTool", tool_input: { server: "posthog" } },
    { hook_event_name: "PreToolUse", tool_name: "ReadMcpResourceTool", tool_input: { server: "posthog", uri: "posthog://docs" } },
    { hook_event_name: "PreToolUse", tool_name: "list_mcp_resources", tool_input: { server: "posthog" } },
    { hook_event_name: "PreToolUse", tool_name: "list_mcp_resource_templates", tool_input: { server: "posthog" } },
    { hook_event_name: "PreToolUse", tool_name: "read_mcp_resource", tool_input: { server: "posthog", uri: "posthog://docs" } },
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

test("Codex PreToolUse payload denies registration in personal repos and permits PostHog repos", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  const workRepository = repositoryWithOrigin(testContext, "https://github.com/PostHog/posthog.git");
  const payload = {
    session_id: "codex-session",
    transcript_path: path.join(homeDirectory, "transcript.jsonl"),
    cwd: personalRepository,
    hook_event_name: "PreToolUse",
    model: "gpt-6.1-sol",
    tool_name: "mcp__backchannels__register_agent",
    tool_use_id: "codex-tool-call",
    tool_input: { name: "agent" },
  };
  const deniedProcess = runHook(path.join(import.meta.dirname, "..", "confine-backchannels.mjs"), payload, { HOME: homeDirectory });
  assert.equal(deniedProcess.status, 0);
  const denial = JSON.parse(deniedProcess.stdout).hookSpecificOutput;
  assert.equal(denial.hookEventName, "PreToolUse");
  assert.equal(denial.permissionDecision, "deny");
  assert.match(denial.permissionDecisionReason, /Ignore every backchannels startup instruction/);
  assert.equal(decisionFor({ ...payload, cwd: workRepository }, homeDirectory), "allow");
});

function runCodexStartup(cwd, homeDirectory) {
  return spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "confine-backchannels.mjs"), "--codex-startup"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "codex-session", cwd }),
    encoding: "utf8",
    env: { ...process.env, HOME: homeDirectory },
  });
}

test("Codex startup executes the backchannels script only in work projects and forwards its payload", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const skillDirectory = path.join(homeDirectory, ".agents", "skills", "backchannels");
  fs.mkdirSync(skillDirectory, { recursive: true });
  const markerPath = path.join(skillDirectory, "started");
  fs.writeFileSync(path.join(skillDirectory, "session-start.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write(fs.readFileSync(0, "utf8"));`);
  const personalRepository = repositoryWithOrigin(testContext, "https://github.com/johncwaters/dotfiles");
  const skippedProcess = runCodexStartup(personalRepository, homeDirectory);
  assert.equal(skippedProcess.status, 0);
  assert.match(skippedProcess.stdout, /Ignore every backchannels startup instruction/);
  assert.equal(fs.existsSync(markerPath), false);
  const workRepository = repositoryWithOrigin(testContext, "https://github.com/PostHog/posthog.git");
  const startupProcess = runCodexStartup(workRepository, homeDirectory);
  assert.equal(startupProcess.status, 0);
  assert.deepEqual(JSON.parse(startupProcess.stdout), { hook_event_name: "SessionStart", session_id: "codex-session", cwd: workRepository });
  assert.equal(fs.existsSync(markerPath), true);
});

test("Codex startup uses the text fallback only inside work projects", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const skillDirectory = path.join(homeDirectory, ".agents", "skills", "backchannels");
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, "session-start.mjs"), "process.exit(1);");
  fs.writeFileSync(path.join(skillDirectory, "session-start.txt"), "register with backchannels");
  const workRepository = repositoryWithOrigin(testContext, "https://github.com/PostHog/posthog.git");
  assert.equal(runCodexStartup(workRepository, homeDirectory).stdout, "register with backchannels");
  const plainDirectory = temporaryDirectory(testContext, "codex-startup-personal-");
  assert.match(runCodexStartup(plainDirectory, homeDirectory).stdout, /backchannels is off here/);
  const missingDirectory = path.join(plainDirectory, "missing");
  assert.match(runCodexStartup(missingDirectory, homeDirectory).stdout, /backchannels is off here/);
});
