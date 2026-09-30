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
  const homeDirectory = temporaryDirectory(testContext, "confine-cloudflare-home-");
  const backchannelClone = initializeRepository(
    path.join(homeDirectory, "Projects", "backchannel"),
    "https://github.com/johncwaters/backchannel.git",
  );
  return { homeDirectory, backchannelClone };
}

function decisionFor(payload, homeDirectory) {
  const processResult = runHook("confine-cloudflare.mjs", payload, { HOME: homeDirectory });
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") return "allow";
  return JSON.parse(processResult.stdout).hookSpecificOutput.permissionDecision;
}

const CLOUDFLARE_COMMANDS = [
  "npx wrangler deploy",
  "cd web && pnpm exec wrangler dev",
  "cf zones list",
  "curl -s https://api.cloudflare.com/client/v4/zones",
  "bash -c 'wrangler deploy'",
  'bash -lc "npx wrangler deploy"',
  "sudo wrangler deploy",
  "env wrangler whoami",
  "exec wrangler deploy",
  'eval "wrangler deploy"',
  "echo deploy | xargs wrangler",
  '"wrangler" deploy',
  "\\wrangler deploy",
  "if wrangler whoami; then echo ok; fi",
  "bun x wrangler deploy",
  "node node_modules/wrangler/bin/wrangler.js deploy",
  "W=wrangler; $W deploy",
  "curl https://API.CLOUDFLARE.COM/client/v4/zones",
  "flarectl zone list",
  "cloudflared tunnel list",
  "sudo cf zones list",
  "bash -c 'cf zones list'",
  "if cf whoami; then echo ok; fi",
  "npx cf zones list",
  "pnpm cf zones list",
  "yarn cf zones",
  "bun cf zones list",
  'c"f" zones list',
  "'cf' zones list",
  "\\cf zones list",
  "yarn --cwd . cf zones",
  "pnpm --dir . cf zones",
  "pnpm --filter a cf zones",
  "pnpm --filter a exec cf",
  "npx --package foo cf zones",
  "bun --cwd . cf",
  "yarn workspace web cf zones",
];

const CLOUDFLARE_CALLS = [
  { tool_name: "mcp__plugin_cloudflare_cloudflare__execute", tool_input: { code: "cloudflare.request()" } },
  { tool_name: "Skill", tool_input: { skill: "cloudflare:workers" } },
  ...CLOUDFLARE_COMMANDS.map((command) => ({ tool_name: "Bash", tool_input: { command } })),
];

test("cloudflare tools, skills, and CLIs are denied outside the backchannel repository", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const otherRepository = initializeRepository(
    path.join(temporaryDirectory(testContext, "confine-cloudflare-other-"), "posthog"),
    "git@github.com:PostHog/posthog.git",
  );
  for (const call of CLOUDFLARE_CALLS) {
    assert.equal(decisionFor({ ...call, cwd: otherRepository }, homeDirectory), "deny", JSON.stringify(call));
  }
});

test("cloudflare tools, skills, and CLIs are allowed inside the backchannel clone", (testContext) => {
  const { homeDirectory, backchannelClone } = homeWithBackchannelClone(testContext);
  for (const call of CLOUDFLARE_CALLS) {
    assert.equal(decisionFor({ ...call, cwd: backchannelClone }, homeDirectory), "allow", JSON.stringify(call));
  }
});

test("a worktree of the backchannel clone is allowed", (testContext) => {
  const { homeDirectory, backchannelClone } = homeWithBackchannelClone(testContext);
  const worktree = path.join(temporaryDirectory(testContext, "confine-cloudflare-worktrees-"), "backchannel-feature");
  const worktreeResult = spawnSync("git", ["-C", backchannelClone, "worktree", "add", "-q", "-b", "feature", worktree]);
  assert.equal(worktreeResult.status, 0);
  assert.equal(decisionFor({ ...CLOUDFLARE_CALLS[0], cwd: worktree }, homeDirectory), "allow");
});

test("a repository elsewhere forging the backchannel origin is denied", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const forgedRepository = initializeRepository(
    path.join(temporaryDirectory(testContext, "confine-cloudflare-forged-"), "backchannel"),
    "git@github.com:johncwaters/backchannel.git",
  );
  assert.equal(decisionFor({ ...CLOUDFLARE_CALLS[0], cwd: forgedRepository }, homeDirectory), "deny");
});

test("a directory outside any repository denies cloudflare", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  const plainDirectory = temporaryDirectory(testContext, "confine-cloudflare-plain-");
  assert.equal(decisionFor({ ...CLOUDFLARE_CALLS[2], cwd: plainDirectory }, homeDirectory), "deny");
});

test("ordinary commands and skills pass untouched anywhere", (testContext) => {
  const { homeDirectory } = homeWithBackchannelClone(testContext);
  for (const call of [
    { tool_name: "Bash", tool_input: { command: "git status" } },
    { tool_name: "Bash", tool_input: { command: "echo cfg && ls wranglerish" } },
    { tool_name: "Bash", tool_input: { command: "pnpm install && yarn test" } },
    { tool_name: "Bash", tool_input: { command: 'echo "cfg" && bun run build' } },
    { tool_name: "Bash", tool_input: { command: "pnpm --filter web build" } },
    { tool_name: "Skill", tool_input: { skill: "commit" } },
    { tool_name: "mcp__plugin_posthog_posthog__exec", tool_input: {} },
  ]) {
    assert.equal(decisionFor({ ...call, cwd: os.tmpdir() }, homeDirectory), "allow", JSON.stringify(call));
  }
});

test("a malformed payload is allowed", () => {
  const processResult = spawnSync("node", [path.join(import.meta.dirname, "..", "confine-cloudflare.mjs")], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});
