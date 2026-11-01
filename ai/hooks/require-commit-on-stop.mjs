#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allow, isAttendedMainLoopCall, nearestExistingDirectory, readPayload } from "./hook-io.mjs";
import { isSkillRun, sessionEvents } from "./session-transcript.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const MAX_LISTED_PATHS = 5;
const FRAMED_BACKGROUND_TOOLS = new Set(["Agent", "Workflow"]);
const BACKGROUND_LAUNCH_FRAMING = /^\s*(?:Async agent launched|Workflow launched in background)/;
const COMMIT_PREFLIGHT_COMMAND = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?node\s+["']?[^\s"']*\/\.claude\/skills\/landing\/preflight\.ts["']?(?:\s|$)/;

function isCommitPreflightCall(event) {
  return event.kind === "toolUse" && event.name === "Bash" && COMMIT_PREFLIGHT_COMMAND.test(String(event.input.command || ""));
}

async function pathsEditedSinceLastCommitRun(transcriptPath) {
  const editedPaths = new Set();
  const pendingPreflightIds = new Set();
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, "landing")) editedPaths.clear();
    if (isCommitPreflightCall(event)) pendingPreflightIds.add(event.id);
    const isPreflightResult = event.kind === "toolResult" && pendingPreflightIds.delete(event.toolUseId);
    if (isPreflightResult && !event.isError) editedPaths.clear();
    if (event.kind !== "toolUse" || !EDIT_TOOLS.has(event.name)) continue;
    const filePath = String(event.input.file_path || "");
    if (path.isAbsolute(filePath)) editedPaths.add(filePath);
  }
  return editedPaths;
}

function isBackgroundLaunchResult(event, backgroundBashToolUseIds, framedBackgroundToolUseIds) {
  if (event.kind !== "toolResult" || event.isError) return false;
  if (backgroundBashToolUseIds.has(event.toolUseId)) return true;
  return framedBackgroundToolUseIds.has(event.toolUseId) && BACKGROUND_LAUNCH_FRAMING.test(event.text);
}

async function hasBackgroundWorkPending(transcriptPath) {
  const backgroundBashToolUseIds = new Set();
  const framedBackgroundToolUseIds = new Set();
  const pendingBackgroundToolUseIds = new Set();
  for await (const event of sessionEvents(transcriptPath)) {
    const isToolUse = event.kind === "toolUse";
    if (isToolUse && event.name === "Bash" && event.input.run_in_background === true) backgroundBashToolUseIds.add(event.id);
    if (isToolUse && FRAMED_BACKGROUND_TOOLS.has(event.name)) framedBackgroundToolUseIds.add(event.id);
    if (isBackgroundLaunchResult(event, backgroundBashToolUseIds, framedBackgroundToolUseIds)) pendingBackgroundToolUseIds.add(event.toolUseId);
    if (event.kind === "taskNotification") pendingBackgroundToolUseIds.delete(event.toolUseId);
  }
  return pendingBackgroundToolUseIds.size > 0;
}

function runGit(directory, args) {
  return spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    timeout: 3000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function groupPathsByWorktree(editedPaths) {
  const claudeDirectory = path.join(os.homedir(), ".claude") + path.sep;
  const pathsByWorktree = new Map();
  for (const filePath of editedPaths) {
    if (filePath.startsWith(claudeDirectory)) continue;
    const toplevelProbe = runGit(nearestExistingDirectory(filePath), ["rev-parse", "--show-toplevel"]);
    const worktree = toplevelProbe.status === 0 ? toplevelProbe.stdout.trim() : "";
    if (!worktree) continue;
    pathsByWorktree.set(worktree, [...(pathsByWorktree.get(worktree) ?? []), filePath]);
  }
  return pathsByWorktree;
}

function uncommittedPaths(pathsByWorktree) {
  const dirtyPaths = [];
  for (const [worktree, filePaths] of pathsByWorktree) {
    const statusProbe = runGit(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ...filePaths]);
    if (statusProbe.status !== 0) continue;
    for (const statusLine of statusProbe.stdout.split("\n")) {
      if (statusLine.trim()) dirtyPaths.push(path.join(worktree, statusLine.slice(3)));
    }
  }
  return dirtyPaths;
}

function blockStop(dirtyPaths) {
  const listedPaths = dirtyPaths.slice(0, MAX_LISTED_PATHS).join(", ");
  const unlistedCount = dirtyPaths.length - MAX_LISTED_PATHS;
  const moreSuffix = unlistedCount > 0 ? ` and ${unlistedCount} more` : "";
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason:
      `This turn ends with uncommitted edits this session made and no /landing since: ${listedPaths}${moreSuffix}. ` +
      "Run the review gate (the intent's gate, else /gating-reviews), then /landing, now. If <land_when_done> exempts this turn (the carbon unit said not to commit, " +
      "the work was exploration, or it is one slice of a plan still in flight), say which in one line and stop again.",
  }));
  process.exit(0);
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || payload.stop_hook_active === true) allow();
  if (!isAttendedMainLoopCall(payload)) allow();
  if (typeof payload.transcript_path !== "string" || !fs.existsSync(payload.transcript_path)) allow();
  const editedPaths = await pathsEditedSinceLastCommitRun(payload.transcript_path);
  if (editedPaths.size === 0) allow();
  const dirtyPaths = uncommittedPaths(groupPathsByWorktree(editedPaths));
  if (dirtyPaths.length === 0) allow();
  if (await hasBackgroundWorkPending(payload.transcript_path)) allow();
  blockStop(dirtyPaths);
}

try {
  await main();
} catch {
  allow();
}
