#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileChangesOf } from "../../../ai/hooks/agent-payload.mjs";
import { allow, denyPreToolUse, nearestExistingDirectory, readPayload } from "../../../ai/hooks/hook-io.mjs";

const GIT_PROBE_ENVIRONMENT = Object.fromEntries(Object.entries(process.env)
  .filter(([variableName]) => !variableName.startsWith("GIT_CONFIG") && !["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].includes(variableName)));

function gitLinesIn(directory, revParseArguments) {
  const gitProbe = spawnSync("git", ["rev-parse", "--path-format=absolute", ...revParseArguments], {
    cwd: directory,
    env: GIT_PROBE_ENVIRONMENT,
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (gitProbe.error || gitProbe.status !== 0) return null;
  return gitProbe.stdout.trim().split("\n");
}

function checkoutOf(directory) {
  const [topLevel, gitDirectory, commonDirectory] = gitLinesIn(directory, ["--show-toplevel", "--git-dir", "--git-common-dir"]) ?? [];
  if (!topLevel || !gitDirectory || !commonDirectory) return null;
  if (gitDirectory !== commonDirectory) return { topLevel, commonDirectory, isMainCheckout: false };
  const [superprojectTopLevel] = gitLinesIn(topLevel, ["--show-superproject-working-tree"]) ?? [];
  if (superprojectTopLevel) return checkoutOf(superprojectTopLevel);
  return { topLevel, commonDirectory, isMainCheckout: true };
}

function editedLocationOf(sessionDirectory, filePath) {
  const absolutePath = path.resolve(sessionDirectory, filePath);
  if (!fs.existsSync(absolutePath)) return nearestExistingDirectory(absolutePath);
  return path.dirname(fs.realpathSync(absolutePath));
}

function denyMainCheckoutEdit(filePath, checkout) {
  denyPreToolUse([
    `Worktree guard blocked this edit to ${path.basename(filePath)}.`,
    `Why: ${checkout.topLevel} is the repo's main checkout, and work changes happen in a dedicated git worktree.`,
    `Fix: create one (git -C ${checkout.topLevel} worktree add <path> -b <branch>, or EnterWorktree), move the session there, and make the edit inside it.`,
  ].join("\n"));
}

function denyOtherWorktreeEdit(filePath, checkout, sessionCheckout) {
  denyPreToolUse([
    `Worktree guard blocked this edit to ${path.basename(filePath)}.`,
    `Why: the session works in ${sessionCheckout.topLevel}, and ${checkout.topLevel} is a different worktree of the same repo.`,
    `Fix: make the edit under ${sessionCheckout.topLevel}, the worktree this session started in.`,
  ].join("\n"));
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const sessionDirectory = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  let sessionCheckout;
  for (const change of fileChangesOf(payload)) {
    const filePath = change.tool_input?.file_path;
    if (typeof filePath !== "string" || !filePath) continue;
    const checkout = checkoutOf(editedLocationOf(sessionDirectory, filePath));
    if (!checkout) continue;
    if (checkout.isMainCheckout) denyMainCheckoutEdit(filePath, checkout);
    sessionCheckout ??= checkoutOf(sessionDirectory);
    if (!sessionCheckout || sessionCheckout.isMainCheckout) continue;
    if (sessionCheckout.commonDirectory !== checkout.commonDirectory || sessionCheckout.topLevel === checkout.topLevel) continue;
    denyOtherWorktreeEdit(filePath, checkout, sessionCheckout);
  }
  allow();
} catch {
  allow();
}
