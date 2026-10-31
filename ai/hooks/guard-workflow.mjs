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
const LANDING_SKILLS = ["committing", "opening-prs"];
const INTERPRETER_EVAL_FLAG = String.raw`\b(?:(?:node|nodejs|bun|deno)(?:\s+-\S+)*\s+(?:-[ep]|--eval|--print)|(?:perl|ruby)(?:\s+-\S+)*\s+-\w*[eE]|php(?:\s+-\S+)*\s+-r|osascript(?:\s+-\S+)*\s+-e)`;
const SHELL_EVALUATES_NEXT_WORD = new RegExp(String.raw`(?:\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c|\beval|\s-c|${INTERPRETER_EVAL_FLAG})\s*$`);
const SHELL_WORD_ON_LINE = /(?:^|[;&|(\s])(?:\S*\/)?(?:(?:ba|z|da|k)?sh|eval)(?=$|[\s;&|)])/;
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*\n)([\s\S]*?\n)?([ \t]*\2[ \t]*(?=\n|$))/g;
const PKILL_CALL = new RegExp(String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}(?:\S*/)?pkill\s+([^;&|\n]*)`, "gm");
const PKILL_FULL_FLAG = /^(?:--full|-[A-Za-z]*f[A-Za-z]*)$/;
const QUOTE_AWARE_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"])+/g;
const BRACKET_CLASS = /\[[^\]]+\]/;

const RAW_COMMIT_REASON =
  "Raw `git commit` and `git push` are denied outside /committing, so every landing goes through its review loop. " +
  "Run /committing; its Step 2 already skips the review for a mechanical change such as a pure rename or a reviewer's suggestion applied verbatim. " +
  "A carbon unit who wants a raw commit runs it themselves with `! git ...`.";

const PKILL_SELF_MATCH_REASON =
  "pkill -f matches full command lines, and this Bash call's own shell carries the same pattern, so it kills itself. " +
  "Run pgrep -f '<pattern>' and kill the PIDs it prints, or bracket one character ('[n]ode server') so the pattern no longer matches its own text.";

const SPEC_GATE_REASON =
  `${SPEC_GATE_MARKER} This is the first repo edit in a session that never ran /specifying. ` +
  "Any change that involves a choice goes through /specifying first: a feature, a behavior change, a refactor, a new skill, hook, agent, or config, a non-trivial bug fix, or a multi-file change. Run /specifying now. " +
  "Retry this same edit only for a typo or mechanical edit with no decision in it, an edit the carbon unit dictated verbatim, or when the carbon unit said to skip /specifying; \"small\" or \"obvious\" is not an exemption. The gate fires once per session.";

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
    if (isSkillRun(event, "specifying") || isSkillRun(event, "converging-reviews")) return true;
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

function maskLiteralHeredocBodies(command) {
  return command.replace(HEREDOC, (heredoc, quote, delimiter, header, body = "", terminator, offset) => {
    const textBeforeHeredoc = command.slice(command.lastIndexOf("\n", offset) + 1, offset);
    const isShellInput = SHELL_WORD_ON_LINE.test(`${textBeforeHeredoc} ${header}`);
    const canExpandCommands = quote === "" && /\$\(|`/.test(body);
    if (isShellInput || canExpandCommands) return heredoc;
    return `<<${quote}${delimiter}${quote}${header}${terminator}`;
  });
}

function maskSingleQuotedText(command) {
  let maskedCommand = "";
  let index = 0;
  let isInsideDoubleQuotes = false;
  while (index < command.length) {
    const character = command[index];
    if (character === "\\") {
      maskedCommand += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') isInsideDoubleQuotes = !isInsideDoubleQuotes;
    if (character !== "'" || isInsideDoubleQuotes) {
      maskedCommand += character;
      index += 1;
      continue;
    }
    const closingIndex = command.indexOf("'", index + 1);
    if (closingIndex === -1) return maskedCommand + command.slice(index);
    const quotedText = command.slice(index, closingIndex + 1);
    const isEvaluatedByShell = SHELL_EVALUATES_NEXT_WORD.test(maskedCommand);
    maskedCommand += isEvaluatedByShell || !/\s/.test(quotedText) ? quotedText : "''";
    index = closingIndex + 1;
  }
  return maskedCommand;
}

function isSelfMatchingPkill(pkillArguments) {
  const words = pkillArguments.match(QUOTE_AWARE_WORD) ?? [];
  if (!words.some((word) => PKILL_FULL_FLAG.test(word))) return false;
  const patternText = words.filter((word) => !word.startsWith("-")).join(" ");
  return patternText !== "" && !BRACKET_CLASS.test(patternText);
}

function guardPkillSelfMatch(command) {
  for (const pkillCall of command.matchAll(PKILL_CALL)) {
    if (isSelfMatchingPkill(pkillCall[1])) denyPreToolUse(PKILL_SELF_MATCH_REASON);
  }
}

async function guardRawCommit(command, transcriptPath) {
  if (!GIT_COMMIT_OR_PUSH.test(maskSingleQuotedText(maskLiteralHeredocBodies(command)))) allow();
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
  if (payload.tool_name === "Bash") guardPkillSelfMatch(String(toolInput.command || ""));
  if (payload.tool_name === "Bash") await guardRawCommit(String(toolInput.command || ""), payload.transcript_path);
  if (EDIT_TOOLS.has(payload.tool_name)) await guardSpecFirst(String(toolInput.file_path || ""), payload.transcript_path);
  allow();
}

try {
  await main();
} catch {
  allow();
}
