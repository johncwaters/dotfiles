#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allow, denyPreToolUse, readPayload } from "../../../ai/hooks/hook-io.mjs";

const BACKCHANNELS_MCP_TOOL = /^mcp__backchannels__/;
const BACKCHANNELS_SKILL = /^backchannels$/i;
const MCP_RESOURCE_TOOLS = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const MAX_SCANNED_WORKSPACE_CHILDREN = 64;
const POSTHOG_ORIGIN = /^(?:(?:https|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:)posthog\//i;

const PERSONAL_PROJECT_NOTICE =
  "backchannels is an internal PostHog tool and this session is in a personal project, so backchannels is off here. " +
  "Ignore every backchannels startup instruction: do not load its tools, register, watch the inbox, join channels, or post.";

function touchesBackchannels(toolName, toolInput) {
  if (BACKCHANNELS_MCP_TOOL.test(toolName)) return true;
  if (toolName === "Skill") return BACKCHANNELS_SKILL.test(String(toolInput.skill || "").trim().replace(/^\//, ""));
  if (!MCP_RESOURCE_TOOLS.has(toolName)) return false;
  const serverName = String(toolInput.server || "").trim();
  return serverName === "" || serverName === "backchannels";
}

function gitOutput(directory, gitArguments) {
  const gitResult = spawnSync("git", ["-C", directory, ...gitArguments], { encoding: "utf8" });
  if (gitResult.status !== 0) return "";
  return gitResult.stdout.trim();
}

function isSameFilesystemObject(firstPath, secondPath) {
  if (!firstPath || !secondPath) return false;
  const firstStat = fs.statSync(firstPath, { throwIfNoEntry: false });
  const secondStat = fs.statSync(secondPath, { throwIfNoEntry: false });
  if (!firstStat || !secondStat) return false;
  return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
}

function isWorkRepository(directory) {
  if (POSTHOG_ORIGIN.test(gitOutput(directory, ["remote", "get-url", "origin"]))) return true;
  const backchannelGitDirectory = path.join(os.homedir(), "Projects", "backchannel", ".git");
  const commonGitDirectory = gitOutput(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return isSameFilesystemObject(commonGitDirectory, backchannelGitDirectory);
}

function childDirectories(workspaceDirectory) {
  return fs
    .readdirSync(workspaceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceDirectory, entry.name));
}

function isRepositoryRoot(directory) {
  return isSameFilesystemObject(gitOutput(directory, ["rev-parse", "--show-toplevel"]), directory);
}

function isWorkProject(directory) {
  if (gitOutput(directory, ["rev-parse", "--is-inside-work-tree"]) === "true") return isWorkRepository(directory);
  const workspaceChildren = childDirectories(directory);
  // Each child spawns git, and Codex lets the call through once the hook outlives its timeout.
  if (workspaceChildren.length > MAX_SCANNED_WORKSPACE_CHILDREN) return false;
  const workspaceRepositories = workspaceChildren.filter(isRepositoryRoot);
  return workspaceRepositories.length > 0 && workspaceRepositories.every(isWorkRepository);
}

function announceForSessionStart(payload, sessionDirectory) {
  if (!isWorkProject(sessionDirectory)) {
    process.stdout.write(PERSONAL_PROJECT_NOTICE);
    allow();
  }
  if (!process.argv.includes("--codex-startup")) allow();
  const skillDirectory = path.join(os.homedir(), ".agents", "skills", "backchannels");
  const startupProcess = spawnSync(process.execPath, [path.join(skillDirectory, "session-start.mjs")], {
    cwd: sessionDirectory,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 4000,
  });
  if (startupProcess.status === 0) {
    process.stdout.write(startupProcess.stdout);
    allow();
  }
  const fallbackPath = path.join(skillDirectory, "session-start.txt");
  if (fs.existsSync(fallbackPath)) process.stdout.write(fs.readFileSync(fallbackPath, "utf8"));
  allow();
}

let isBackchannelsCall = false;
let isSessionStart = false;

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const sessionDirectory = String(payload.cwd || process.cwd());
  isSessionStart = payload.hook_event_name === "SessionStart";
  if (isSessionStart) announceForSessionStart(payload, sessionDirectory);
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  isBackchannelsCall = touchesBackchannels(String(payload.tool_name || ""), toolInput);
  if (!isBackchannelsCall) allow();
  if (isWorkProject(sessionDirectory)) allow();
  denyPreToolUse(`${PERSONAL_PROJECT_NOTICE} Do not retry or work around it.`);
}

try {
  main();
} catch {
  if (isSessionStart) process.stdout.write(PERSONAL_PROJECT_NOTICE);
  if (!isBackchannelsCall) allow();
  denyPreToolUse("backchannels confinement check failed, so the call is denied rather than left unconfined.");
}
