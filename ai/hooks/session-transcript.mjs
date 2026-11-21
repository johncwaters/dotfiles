import fs from "node:fs";
import path from "node:path";
import { asObject, asText, contentText, isSyntheticPrompt, transcriptEntries } from "../skills/running-retros/lib/digest.ts";
import { declaredAgent, normalizePayload, splitPatch } from "./agent-payload.mjs";

const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;
const TASK_NOTIFICATION_TOOL_USE_ID = /<task-notification>[\s\S]*?<tool-use-id>([^<\s]+)<\/tool-use-id>/g;

function contentBlocks(entry) {
  const content = asObject(entry.message)?.content;
  return Array.isArray(content) ? content.map(asObject) : [];
}

function* taskNotifications(value) {
  for (const notification of JSON.stringify(value ?? "").matchAll(TASK_NOTIFICATION_TOOL_USE_ID)) {
    yield { kind: "taskNotification", toolUseId: notification[1] };
  }
}

function* entryEvents(entry, skillNamesByToolUseId) {
  const content = asObject(entry.message)?.content;
  if (entry.type === "user") {
    const promptText = contentText(content).trim();
    const slashCommandName = promptText.match(SLASH_COMMAND)?.[1];
    if (slashCommandName && entry.isMeta !== true) yield { kind: "slashCommand", name: slashCommandName };
    if (!isSyntheticPrompt(promptText, entry)) yield { kind: "prompt" };
    if (entry.isMeta === true && promptText.startsWith("Stop hook feedback:")) yield { kind: "stopFeedback", text: promptText };
    yield* taskNotifications(content);
    for (const block of contentBlocks(entry)) {
      if (block?.type !== "tool_result") continue;
      const isError = block.is_error === true;
      const skillName = skillNamesByToolUseId.get(asText(block.tool_use_id));
      if (skillName && !isError) yield { kind: "skillRun", name: skillName };
      yield { kind: "toolResult", toolUseId: asText(block.tool_use_id), text: contentText(block.content), isError };
    }
    return;
  }
  const attachment = asObject(entry.attachment);
  if (entry.type === "attachment" && attachment?.type === "queued_command") {
    yield* taskNotifications(attachment.prompt);
    return;
  }
  if (entry.type !== "assistant") return;
  for (const block of contentBlocks(entry)) {
    if (block?.type !== "tool_use") continue;
    const input = asObject(block.input) ?? {};
    if (block.name === "Skill" && typeof input.skill === "string") skillNamesByToolUseId.set(asText(block.id), input.skill);
    yield { kind: "toolUse", id: asText(block.id), name: asText(block.name), input };
  }
}

async function* claudeTranscriptEvents(transcriptPath) {
  const skillNamesByToolUseId = new Map();
  for await (const entry of transcriptEntries(transcriptPath)) {
    if (entry) yield* entryEvents(entry, skillNamesByToolUseId);
  }
}

const SKILL_FILE_PATH = /[\\/]skills[\\/]([\w.-]+)[\\/]SKILL\.md\b/;
const CODEX_SKILL_MESSAGE = /^<skill>\s*<name>([^<]+)<\/name>/;
const CODEX_SYNTHETIC_PROMPT = /^(?:# AGENTS\.md instructions|<environment_context>|<skill>|<user_instructions>|<turn_aborted>)/;
const CODEX_INNER_TOOL_CALL = /\btools\.(exec_command|apply_patch)\(/g;
const JS_STRING_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

function readStringLiteral(source, startIndex) {
  const quote = source[startIndex];
  if (!["\"", "'", "`"].includes(quote)) return null;
  let literal = "";
  for (let index = startIndex + 1; index < source.length; index++) {
    const character = source[index];
    if (character === quote) return literal;
    if (quote === "`" && character === "$" && source[index + 1] === "{") return null;
    if (character !== "\\") {
      literal += character;
      continue;
    }
    const escaped = source[++index];
    const unicodeEscape = escaped === "u" ? /^[0-9a-fA-F]{4}/.exec(source.slice(index + 1)) : null;
    if (unicodeEscape) {
      literal += String.fromCharCode(Number.parseInt(unicodeEscape[0], 16));
      index += 4;
      continue;
    }
    literal += JS_STRING_ESCAPES[escaped] ?? escaped;
  }
  return null;
}

function readStringArgument(script, valueStart) {
  const literal = readStringLiteral(script, valueStart);
  if (literal !== null) return literal;
  const identifier = /^[A-Za-z_$][\w$]*/.exec(script.slice(valueStart))?.[0];
  if (!identifier) return null;
  const binding = new RegExp(`\\b(?:const|let|var)\\s+${identifier.replace(/\$/g, "\\$")}\\s*=\\s*`).exec(script);
  return binding ? readStringLiteral(script, binding.index + binding[0].length) : null;
}

function* codexInnerToolCalls(script) {
  for (const call of script.matchAll(CODEX_INNER_TOOL_CALL)) {
    const argumentsStart = call.index + call[0].length;
    if (call[1] === "apply_patch") {
      const patch = readStringArgument(script, script.slice(argumentsStart).search(/\S/) + argumentsStart);
      if (patch !== null) yield { name: "apply_patch", input: { input: patch } };
      continue;
    }
    const commandKey = /^\s*\{\s*(["']?)cmd\1\s*:\s*/.exec(script.slice(argumentsStart));
    const command = commandKey ? readStringArgument(script, argumentsStart + commandKey[0].length) : null;
    if (command !== null) yield { name: "exec_command", input: { cmd: command } };
  }
}

function skillNameAt(skillFilePath) {
  const folderName = skillFilePath.match(SKILL_FILE_PATH)?.[1];
  if (!folderName) return undefined;
  const skillFile = skillFilePath.match(/\S*[\\/]skills[\\/][\w.-]+[\\/]SKILL\.md/)?.[0]?.replace(/^["'`]/, "");
  const frontmatterName = skillFile && fs.existsSync(skillFile) ? /^name:\s*(\S+)/m.exec(fs.readFileSync(skillFile, "utf8"))?.[1] : undefined;
  return frontmatterName ?? folderName;
}

function parsedArguments(argumentText) {
  try {
    return asObject(JSON.parse(argumentText)) ?? {};
  } catch {
    return { input: argumentText };
  }
}

function patchedFilePaths(patch, workingDirectory) {
  return (splitPatch(patch) ?? []).flatMap((patchFile) => [...new Set([patchFile.sourcePath, patchFile.file_path])].map((filePath) => path.resolve(workingDirectory, filePath)));
}

function* codexToolEvents(id, name, input, workingDirectory) {
  if (["exec_command", "shell", "local_shell"].includes(name)) {
    const command = Array.isArray(input.command) ? input.command.join(" ") : asText(input.cmd) || asText(input.command);
    const skillName = skillNameAt(command);
    if (skillName) yield { kind: "skillRun", name: skillName };
    yield { kind: "toolUse", id, name: "Bash", input: { command } };
    return;
  }
  if (name === "apply_patch") {
    for (const filePath of patchedFilePaths(asText(input.input) || asText(input.patch), workingDirectory)) {
      yield { kind: "toolUse", id, name: "Edit", input: { file_path: filePath } };
    }
    return;
  }
  const normalized = normalizePayload({ tool_name: name, tool_input: input }, "codex");
  yield { kind: "toolUse", id, name: asText(normalized.tool_name), input: asObject(normalized.tool_input) ?? {} };
}

function* codexUserMessageEvents(message) {
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const text = asText(asObject(block)?.text).trim();
    if (text && !CODEX_SYNTHETIC_PROMPT.test(text)) yield { kind: "prompt" };
    const skillName = text.match(CODEX_SKILL_MESSAGE)?.[1]?.trim();
    if (skillName) yield { kind: "skillRun", name: skillName };
  }
}

function codexOutputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((block) => asText(asObject(block)?.text)).join("\n");
  return asText(asObject(output)?.content);
}

async function* codexRolloutEvents(transcriptPath) {
  let workingDirectory = process.cwd();
  for await (const entry of transcriptEntries(transcriptPath)) {
    const item = asObject(entry?.payload);
    if (!item) continue;
    if (entry.type === "turn_context" && typeof item.cwd === "string") workingDirectory = item.cwd;
    if (entry.type !== "response_item") continue;
    const callId = asText(item.call_id);
    if (item.type === "message" && item.role === "user") yield* codexUserMessageEvents(item);
    if (item.type === "function_call") yield* codexToolEvents(callId, asText(item.name), parsedArguments(asText(item.arguments)), workingDirectory);
    if (item.type === "custom_tool_call" && item.name === "exec") {
      for (const innerCall of codexInnerToolCalls(asText(item.input))) yield* codexToolEvents(callId, innerCall.name, innerCall.input, workingDirectory);
    }
    if (item.type === "custom_tool_call" && item.name !== "exec") yield* codexToolEvents(callId, asText(item.name), { input: asText(item.input) }, workingDirectory);
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      yield { kind: "toolResult", toolUseId: callId, text: codexOutputText(item.output), isError: false };
    }
  }
}

const AGY_SLASH_COMMAND = /^\/([\w.-]+)/;
const AGY_READ_TOOLS = new Set(["read_file", "view_file"]);
const AGY_STEP_TYPES_WITHOUT_TOOL_OUTPUT = new Set(["USER_INPUT", "PLANNER_RESPONSE", "SYSTEM_MESSAGE"]);

function agyRequestText(content) {
  return (/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content).trim();
}

function* agyToolCallEvents(step, pendingToolUseIds) {
  const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  for (const [callIndex, toolCall] of toolCalls.entries()) {
    const call = asObject(toolCall) ?? {};
    const id = `${step.step_index ?? ""}:${callIndex}`;
    const normalized = normalizePayload({ toolCall: { name: call.name, args: call.args } }, "agy");
    const input = asObject(normalized.tool_input) ?? {};
    const skillName = AGY_READ_TOOLS.has(call.name) ? skillNameAt(asText(input.file_path) || asText(input.Path) || JSON.stringify(input)) : undefined;
    if (skillName) yield { kind: "skillRun", name: skillName };
    pendingToolUseIds.push(id);
    yield { kind: "toolUse", id, name: asText(normalized.tool_name), input };
  }
}

async function* agyTranscriptEvents(transcriptPath) {
  const pendingToolUseIds = [];
  for await (const step of transcriptEntries(transcriptPath)) {
    if (!step) continue;
    const content = asText(step.content);
    if (step.type === "USER_INPUT") {
      const requestText = agyRequestText(content);
      const slashCommandName = requestText.match(AGY_SLASH_COMMAND)?.[1];
      if (slashCommandName) yield { kind: "slashCommand", name: slashCommandName };
      if (requestText) yield { kind: "prompt" };
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      if (content.trim()) yield { kind: "reply", text: content };
      yield* agyToolCallEvents(step, pendingToolUseIds);
      continue;
    }
    if (AGY_STEP_TYPES_WITHOUT_TOOL_OUTPUT.has(step.type) || pendingToolUseIds.length === 0) continue;
    yield { kind: "toolResult", toolUseId: pendingToolUseIds.shift(), text: content, isError: step.status === "ERROR" };
  }
}

const TRANSCRIPT_READERS = { claude: claudeTranscriptEvents, codex: codexRolloutEvents, agy: agyTranscriptEvents };

export async function* sessionEvents(transcriptPath, agent = declaredAgent()) {
  yield* (TRANSCRIPT_READERS[agent] ?? claudeTranscriptEvents)(transcriptPath);
}

export async function finalTurnOf(transcriptPath, agent = declaredAgent()) {
  let replyText = null;
  let stopFeedbackTexts = [];
  for await (const event of sessionEvents(transcriptPath, agent)) {
    if (event.kind === "prompt") {
      replyText = null;
      stopFeedbackTexts = [];
    }
    if (event.kind === "reply") replyText = event.text;
    if (event.kind === "stopFeedback") stopFeedbackTexts.push(event.text);
  }
  return { replyText, stopFeedbackTexts };
}

export async function finalReply(transcriptPath, agent = declaredAgent()) {
  return (await finalTurnOf(transcriptPath, agent)).replyText;
}

export function isSkillRun(event, skillName) {
  if (event.kind === "slashCommand") return event.name === skillName;
  return event.kind === "skillRun" && event.name === skillName;
}
