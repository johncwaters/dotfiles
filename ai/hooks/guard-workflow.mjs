#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allow, COMMAND_START, COMMAND_WRAPPERS, denyPreToolUse, isAttendedMainLoopCall, nearestExistingDirectory, readPayload } from "./hook-io.mjs";
import { isSkillRun, sessionEvents } from "./session-transcript.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SPEC_GATE_MARKER = "[spec-gate]";
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
const GIT_ALIAS_TO_COMMIT_OR_PUSH = String.raw`-c\s*(?:alias\.[^=\s]+=\S*|"alias\.[^"=]+=[^"]*|'alias\.[^'=]+=[^']*)\b(?:commit|push)\b`;
const GIT_COMMIT_OR_PUSH = new RegExp(
  String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?git['"]?${GIT_GLOBAL_OPTIONS}\s+(?:(?:commit|push)(?=\s|$|[;&|)'"])|${GIT_ALIAS_TO_COMMIT_OR_PUSH})`,
  "m",
);
const LANDING_SKILLS = ["commit", "open-pr"];

const RAW_COMMIT_REASON =
  "Raw `git commit` and `git push` are denied outside /commit, so every landing goes through its review loop. " +
  "Run /commit; its Step 2 already skips the review for a mechanical change such as a pure rename or a reviewer's suggestion applied verbatim. " +
  "A carbon unit who wants a raw commit runs it themselves with `! git ...`.";

const SPEC_GATE_REASON =
  `${SPEC_GATE_MARKER} This is the first repo edit in a session that never ran /spec. ` +
  "A feature request goes through /spec before any code changes. " +
  "A bug fix, a mechanical change, or an edit the carbon unit dictated: retry this same edit; the gate fires once per session.";

async function hasLandingSkillRunSinceLastPrompt(transcriptPath) {
  let hasLandingSkillRun = false;
  for await (const event of sessionEvents(transcriptPath)) {
    if (event.kind === "prompt") hasLandingSkillRun = false;
    if (LANDING_SKILLS.some((skillName) => isSkillRun(event, skillName))) hasLandingSkillRun = true;
  }
  return hasLandingSkillRun;
}

function isInsideDirectory(filePath, directory) {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSpecGateDenial(event) {
  return event.kind === "toolResult" && event.isError && event.text.startsWith("PreToolUse:") && event.text.includes(SPEC_GATE_MARKER);
}

async function hasSpecGateCleared(transcriptPath, specsDirectory) {
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, "spec")) return true;
    if (isSpecGateDenial(event)) return true;
    if (event.kind !== "toolUse" || event.name !== "Read") continue;
    const readPath = String(event.input.file_path || "");
    if (path.isAbsolute(readPath) && isInsideDirectory(readPath, specsDirectory)) return true;
  }
  return false;
}

function isInsideGitWorktree(filePath) {
  const gitProbe = spawnSync("git", ["-C", nearestExistingDirectory(filePath), "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return gitProbe.status === 0 && gitProbe.stdout.trim() === "true";
}

async function guardRawCommit(command, transcriptPath) {
  if (!GIT_COMMIT_OR_PUSH.test(command)) allow();
  if (await hasLandingSkillRunSinceLastPrompt(transcriptPath)) allow();
  denyPreToolUse(RAW_COMMIT_REASON);
}

async function guardSpecFirst(filePath, transcriptPath) {
  const claudeDirectory = path.join(os.homedir(), ".claude");
  if (!path.isAbsolute(filePath) || isInsideDirectory(filePath, claudeDirectory)) allow();
  if (!isInsideGitWorktree(filePath)) allow();
  if (await hasSpecGateCleared(transcriptPath, path.join(claudeDirectory, "specs"))) allow();
  denyPreToolUse(SPEC_GATE_REASON);
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || !isAttendedMainLoopCall(payload)) allow();
  if (typeof payload.transcript_path !== "string" || !fs.existsSync(payload.transcript_path)) allow();
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (payload.tool_name === "Bash") await guardRawCommit(String(toolInput.command || ""), payload.transcript_path);
  if (EDIT_TOOLS.has(payload.tool_name)) await guardSpecFirst(String(toolInput.file_path || ""), payload.transcript_path);
  allow();
}

try {
  await main();
} catch {
  allow();
}
