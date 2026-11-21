#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allow, blockStop, readPayload } from "./hook-io.mjs";
import { finalTurnOf } from "./session-transcript.mjs";

const PERSON_WORDS = /\b(?:humans?|persons?|people|developers?|engineers?|users?)\b(?![-_/.]\w)/gi;
const QUOTED_OR_CODE_SPANS = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]*`/g,
  /^\s*>.*$/gm,
  /"[^"\n]*"/g,
  /“[^”\n]*”/g,
  /\bhttps?:\/\/\S+/g,
];
const CARBON_UNIT_MARKER = "where <output_style> requires";
const SELF_RUN_MARKER = "commands you can run yourself";
const TRANSCRIPT_FEEDBACK_AGENTS = new Set(["claude", "agy"]);

const SHELL_FENCE = /^[ \t]*```([\w-]*)[^\n`]*\n([\s\S]*?)^[ \t]*```/gm;
const SHELL_FENCE_LANGUAGES = new Set(["", "sh", "bash", "shell", "zsh", "console"]);
const BANG_COMMAND = /(?:^|\n)[ \t]*(?:[-*][ \t]+|\d+\.[ \t]+)?`?![ \t]+([^`\n]+)`?|`![ \t]+([^`\n]+)`/g;
const ADDRESSED_TO_CARBON_UNIT = /\byou(?:'ll)?\s+(?:can\s+|could\s+|need\s+to\s+|should\s+|must\s+|will\s+need\s+to\s+)?(?:run|paste|execute|type|enter)\b|\bin\s+your\s+(?:own\s+)?(?:terminal|shell)\b|\b(?:run|paste|execute)\s+(?:this|these|it|them)\s+yourself\b|(?:^|\n)[ \t]*(?:run|paste|execute)\b[^\n]*:\s*$/i;
const INTERACTIVE_PROGRAM = /^(?:sudo|doas|su|passwd|chsh|ssh-keygen|ssh-add|ssh-copy-id|kinit)\b|^gpg\s+--(?:full-)?gen(?:erate)?-key\b|^tailscale\s+up\b|^aws\s+configure\b|^open\s+https?:/;
const INTERACTIVE_SUBCOMMAND = /(?:^|\s)(?:auth|login|signin|sign-in|adduser|setup-token)\b|^op\s+account\s+add\b/;
const CARBON_UNIT_DECISION = /\brm\s+-\w*[rf]|\bgit\s+(?:push|reset\s+--hard|clean\s+-\w*f|branch\s+-D|filter-(?:branch|repo))\b|--force\b|\b(?:drop\s+(?:table|database)|truncate\s+table)\b|\b(?:npm|pnpm|yarn|cargo|gem)\s+publish\b|\bgh\s+(?:release|pr\s+merge|repo\s+delete)\b|\b(?:kubectl\s+delete|terraform\s+(?:apply|destroy)|helm\s+uninstall)\b|\bdeploy\b/i;
const SCRIPT_RUN = /^(?:(?:ba|z)?sh\s+)?"?((?:~|\$HOME|\/)[^\s"]*)"?(?:\s.*)?$/;
const COMMAND_PREFIX = /^(?:(?:[A-Za-z_]\w*=\S*|env|nohup|command|time|npx|bunx|pnpm\s+dlx|yarn(?:\s+npm)?|pnpm|exec)\s+)+/;
const HANDING_VERB_BEFORE_SPAN = /\b(?:run|type|paste|execute|enter)\s*$/i;
const COMMAND_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;

function proseOutsideCodeAndQuotes(message) {
  return QUOTED_OR_CODE_SPANS.reduce((remainingText, span) => remainingText.replace(span, " "), message);
}

function hasTranscript(payload) {
  return typeof payload.transcript_path === "string" && fs.existsSync(payload.transcript_path);
}

async function finalTurnStateOf(payload) {
  const canReadTranscript = hasTranscript(payload);
  const turn = canReadTranscript && (payload.agent === "claude" || typeof payload.last_assistant_message !== "string")
    ? await finalTurnOf(payload.transcript_path, payload.agent)
    : { replyText: null, stopFeedbackTexts: [] };
  return {
    replyText: typeof payload.last_assistant_message === "string" || !canReadTranscript ? payload.last_assistant_message : turn.replyText,
    hasSentBack: (marker) => (TRANSCRIPT_FEEDBACK_AGENTS.has(payload.agent) && canReadTranscript
      ? turn.stopFeedbackTexts.some((feedbackText) => feedbackText.includes(marker))
      : payload.stop_hook_active === true),
  };
}

function paragraphAround(replyText, index) {
  const paragraphStart = replyText.lastIndexOf("\n\n", index);
  const paragraphEnd = replyText.indexOf("\n\n", index);
  return replyText.slice(paragraphStart + 1, paragraphEnd === -1 ? undefined : paragraphEnd);
}

function isInlineSpanHandedOver(replyText, match) {
  const textBeforeSpan = replyText.slice(Math.max(0, match.index - 40), match.index);
  return HANDING_VERB_BEFORE_SPAN.test(textBeforeSpan) || ADDRESSED_TO_CARBON_UNIT.test(paragraphAround(replyText, match.index));
}

function bangCommandsOf(replyText) {
  return [...replyText.matchAll(BANG_COMMAND)]
    .filter((match) => match[1] !== undefined || isInlineSpanHandedOver(replyText, match))
    .map((match) => (match[1] ?? match[2]).trim())
    .filter(Boolean);
}

function addressedFenceCommandsOf(replyText) {
  const commands = [];
  for (const fence of replyText.matchAll(SHELL_FENCE)) {
    if (!SHELL_FENCE_LANGUAGES.has(fence[1].toLowerCase())) continue;
    const precedingParagraph = replyText.slice(Math.max(0, fence.index - 300), fence.index).split(/\n[ \t]*\n/).filter((paragraph) => paragraph.trim()).at(-1) ?? "";
    if (!ADDRESSED_TO_CARBON_UNIT.test(precedingParagraph)) continue;
    const fenceCommand = fence[2].replace(/\\\n/g, " ").split("\n")
      .map((line) => line.trim().replace(/^(?:\$|!)\s+/, ""))
      .filter((line) => line && !line.startsWith("#"))
      .join(" && ");
    if (fenceCommand) commands.push(fenceCommand);
  }
  return commands;
}

function isScriptOutsideSession(bareCommand, sessionDirectory) {
  const scriptPath = bareCommand.match(SCRIPT_RUN)?.[1];
  if (!scriptPath) return false;
  if (!sessionDirectory || !path.relative(sessionDirectory, os.homedir()).startsWith("..")) return true;
  const absoluteScriptPath = scriptPath.replace(/^(?:~|\$HOME)(?=\/|$)/, os.homedir());
  const relativeToSession = path.relative(sessionDirectory, absoluteScriptPath);
  return relativeToSession.startsWith("..") || path.isAbsolute(relativeToSession);
}

function needsCarbonUnit(command, sessionDirectory) {
  if (CARBON_UNIT_DECISION.test(command)) return true;
  return command.split(COMMAND_SEPARATOR).some((segment) => {
    const bareCommand = segment.replace(COMMAND_PREFIX, "");
    return INTERACTIVE_PROGRAM.test(bareCommand) || INTERACTIVE_SUBCOMMAND.test(bareCommand) || isScriptOutsideSession(bareCommand, sessionDirectory);
  });
}

function selfRunReason(replyText, sessionDirectory) {
  const bangCommands = bangCommandsOf(replyText);
  const handedCommands = [...new Set([...bangCommands, ...addressedFenceCommandsOf(replyText)])];
  const runnableCommands = handedCommands.filter((command) => !needsCarbonUnit(command, sessionDirectory));
  if (runnableCommands.length > 0) {
    return `The reply hands over ${runnableCommands.slice(0, 3).map((command) => `\`${command.slice(0, 80)}\``).join(", ")}, commands you can run yourself. ` +
      "Run them now, in the background when long (run_in_background, or agy's WaitMsBeforeAsync of 10 seconds or less), and keep working; " +
      "hand over only steps that need the carbon unit, such as a login, as one script file.";
  }
  if (bangCommands.length < 2) return "";
  return `The reply hands over ${bangCommands.length} \`!\` commands; besides commands you can run yourself, ` +
    "interactive steps ship as one script file the carbon unit runs in their own terminal.";
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || payload.agent_id) allow();
  const turnState = await finalTurnStateOf(payload);
  const replyText = turnState.replyText;
  if (typeof replyText !== "string") allow();
  const personWordsUsed = [...new Set(proseOutsideCodeAndQuotes(replyText).match(PERSON_WORDS) ?? [])];
  if (personWordsUsed.length > 0 && !turnState.hasSentBack(CARBON_UNIT_MARKER)) {
    blockStop(
      `The reply says ${personWordsUsed.map((word) => `"${word}"`).join(", ")} where <output_style> requires "carbon unit" or "carbon units". ` +
      "Resend the reply with that wording; code, identifiers, verbatim quotes, and user-level terms stay as they are.",
    );
  }
  if (turnState.hasSentBack(SELF_RUN_MARKER)) allow();
  const sessionDirectory = typeof payload.cwd === "string" ? payload.cwd : "";
  const reason = selfRunReason(replyText, sessionDirectory);
  if (reason) blockStop(reason);
  allow();
}

try {
  await main();
} catch {
  allow();
}
