import fs from "node:fs";
import path from "node:path";

export const AGY_FOREGROUND_WAIT_LIMIT_MS = 10000;

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

const DECLARED_AGENTS = new Set(["claude", "codex", "agy"]);
const HEREDOC_OPENERS = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

export function declaredAgent(argumentList = process.argv.slice(2)) {
  const declaration = argumentList.find((argument) => argument.startsWith("--agent="));
  const agent = declaration?.slice("--agent=".length);
  return DECLARED_AGENTS.has(agent) ? agent : "claude";
}

function startHunk(patchFile, context) {
  const hunk = { context, beforeLines: [], afterLines: [], isEndOfFile: false };
  patchFile.hunks.push(hunk);
  return hunk;
}

export function splitPatch(command) {
  if (typeof command !== "string") return null;
  let lines = command.trim().split(/\r?\n/);
  if (HEREDOC_OPENERS.has(lines[0]) && lines.at(-1).endsWith("EOF")) lines = lines.slice(1, -1);
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return null;
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      currentFile = {
        operation: header[1],
        sourcePath: header[2],
        file_path: header[2],
        hunks: [],
        hasMoved: false,
        hasEnded: false,
      };
      currentHunk = null;
      files.push(currentFile);
      continue;
    }
    if (!currentFile || currentFile.operation === "Delete" || currentFile.hasEnded) return null;
    const movedPath = /^\*\*\* Move to: (.+)$/.exec(line);
    if (movedPath) {
      if (currentFile.operation !== "Update" || currentFile.hasMoved || currentFile.hunks.length) return null;
      currentFile.file_path = movedPath[1];
      currentFile.hasMoved = true;
      continue;
    }
    const hunkHeader = /^@@(?: (.*)|)$/.exec(line);
    if (hunkHeader) {
      if (currentFile.operation !== "Update") return null;
      currentHunk = startHunk(currentFile, hunkHeader[1]);
      continue;
    }
    if (line === "*** End of File") {
      if (currentFile.operation !== "Update") return null;
      currentFile.hasEnded = true;
      if (currentHunk) currentHunk.isEndOfFile = true;
      continue;
    }
    const hunkLine = line === "" && currentFile.operation === "Update" ? " " : line;
    const prefix = hunkLine[0];
    if (![" ", "+", "-"].includes(prefix)) return null;
    if (currentFile.operation === "Add" && prefix !== "+") return null;
    currentHunk ??= startHunk(currentFile);
    if (prefix !== "+") currentHunk.beforeLines.push(hunkLine.slice(1));
    if (prefix !== "-") currentHunk.afterLines.push(hunkLine.slice(1));
  }
  return files;
}

const PATCH_LINE_COMPARISONS = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
  (line) => line.trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "),
];

function seekSequence(lines, pattern, startIndex, isEndOfFile) {
  if (pattern.length === 0) return startIndex;
  if (pattern.length > lines.length) return -1;
  const searchStart = isEndOfFile ? lines.length - pattern.length : startIndex;
  for (const comparable of PATCH_LINE_COMPARISONS) {
    for (let index = searchStart; index <= lines.length - pattern.length; index++) {
      if (pattern.every((patternLine, offset) => comparable(lines[index + offset]) === comparable(patternLine))) return index;
    }
  }
  return -1;
}

function locateHunk(lines, hunk, lineIndex) {
  const location = { start: seekSequence(lines, hunk.beforeLines, lineIndex, hunk.isEndOfFile), oldLines: hunk.beforeLines, newLines: hunk.afterLines };
  if (location.start >= 0 || hunk.beforeLines.at(-1) !== "") return location;
  const oldLines = hunk.beforeLines.slice(0, -1);
  const newLines = hunk.afterLines.at(-1) === "" ? hunk.afterLines.slice(0, -1) : hunk.afterLines;
  return { start: seekSequence(lines, oldLines, lineIndex, hunk.isEndOfFile), oldLines, newLines };
}

function applyPatchHunks(original, hunks) {
  const lines = original.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements = [];
  let lineIndex = 0;
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const contextIndex = seekSequence(lines, [hunk.context], lineIndex, false);
      if (contextIndex < 0) return null;
      lineIndex = contextIndex + 1;
    }
    if (hunk.beforeLines.length === 0) {
      replacements.push({ start: lines.length, oldLines: [], newLines: hunk.afterLines });
      continue;
    }
    const location = locateHunk(lines, hunk, lineIndex);
    if (location.start < 0) return null;
    replacements.push(location);
    lineIndex = location.start + location.oldLines.length;
  }
  replacements.sort((first, second) => second.start - first.start);
  for (const replacement of replacements) lines.splice(replacement.start, replacement.oldLines.length, ...replacement.newLines);
  lines.push("");
  return lines.join("\n");
}

function readExistingText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (readError) {
    if (readError?.code === "ENOENT") return null;
    throw readError;
  }
}

function patchFileChange(patchFile, workingDirectory) {
  const file_path = path.resolve(workingDirectory, patchFile.file_path);
  const baseline_path = path.resolve(workingDirectory, patchFile.sourcePath);
  if (patchFile.operation === "Add") {
    const content = patchFile.hunks.flatMap((hunk) => hunk.afterLines).join("\n");
    return { tool_name: "Write", tool_input: { file_path, content: content ? `${content}\n` : "" } };
  }
  const baseline = readExistingText(baseline_path);
  if (baseline === null) {
    const edits = patchFile.hunks.map((hunk) => ({ old_string: hunk.beforeLines.join("\n"), new_string: hunk.afterLines.join("\n") }));
    return { tool_name: "MultiEdit", tool_input: { file_path, edits } };
  }
  const content = applyPatchHunks(baseline, patchFile.hunks);
  if (content === null) return null;
  return { tool_name: "Write", tool_input: { file_path, baseline_path, content } };
}

function patchFileChanges(command, workingDirectory) {
  const patchFiles = splitPatch(command) ?? [];
  return patchFiles
    .filter((patchFile) => patchFile.operation !== "Delete")
    .map((patchFile) => patchFileChange(patchFile, workingDirectory))
    .filter(Boolean);
}

function textArgument(value) {
  return typeof value === "string" ? value : undefined;
}

function agyReplacementEdits(args) {
  const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [args];
  return chunks
    .filter((chunk) => chunk && typeof chunk === "object")
    .map((chunk) => ({
      old_string: textArgument(chunk.TargetContent),
      new_string: textArgument(chunk.ReplacementContent),
      ...(chunk.AllowMultiple === true ? { replace_all: true } : {}),
    }));
}

function agyQuestions(args) {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  return questions.map((question) => ({
    question: question?.question,
    multiSelect: question?.is_multi_select === true,
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({ label: String(option) })),
  }));
}

function agyRunsInBackground(args) {
  const waitMs = typeof args.WaitMsBeforeAsync === "number" ? args.WaitMsBeforeAsync : 0;
  return waitMs <= AGY_FOREGROUND_WAIT_LIMIT_MS;
}

const AGY_TOOL_MAPPERS = {
  run_command: (args) => ({
    tool_name: "Bash",
    tool_input: { command: textArgument(args.CommandLine), run_in_background: agyRunsInBackground(args), cwd: textArgument(args.Cwd) },
  }),
  write_file: (args) => ({ tool_name: "Write", tool_input: { file_path: textArgument(args.Path), content: textArgument(args.Content) } }),
  create_file: (args) => ({ tool_name: "Write", tool_input: { file_path: textArgument(args.Path), content: textArgument(args.Content) } }),
  replace_file_content: (args) => ({ tool_name: "MultiEdit", tool_input: { file_path: textArgument(args.TargetFile), edits: agyReplacementEdits(args) } }),
  multi_replace_file_content: (args) => ({ tool_name: "MultiEdit", tool_input: { file_path: textArgument(args.TargetFile), edits: agyReplacementEdits(args) } }),
  ask_question: (args) => ({ tool_name: "AskUserQuestion", tool_input: { questions: agyQuestions(args) } }),
  invoke_subagent: (args) => ({ tool_name: "Agent", tool_input: { prompt: textArgument(args.Prompt), description: textArgument(args.Role), subagent_type: textArgument(args.TypeName) } }),
};

function normalizeAgy(rawPayload) {
  const toolCall = rawPayload.toolCall && typeof rawPayload.toolCall === "object" ? rawPayload.toolCall : null;
  const args = toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const mapTool = AGY_TOOL_MAPPERS[toolCall?.name];
  const mappedTool = mapTool ? mapTool(args) : { tool_name: toolCall?.name, tool_input: args };
  return {
    ...rawPayload,
    ...mappedTool,
    agent: "agy",
    hook_event_name: rawPayload.hookEventName,
    session_id: rawPayload.conversationId,
    transcript_path: rawPayload.transcriptPath,
    stop_hook_active: rawPayload.continuationActive === true,
  };
}

function codexSpawnInput(toolInput) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const itemTexts = (Array.isArray(input.items) ? input.items : [])
    .map((item) => item?.text)
    .filter((text) => typeof text === "string");
  const itemPrompt = itemTexts.length > 0 ? itemTexts.join("\n") : undefined;
  const prompt = [input.prompt, input.message, input.task, itemPrompt].find((value) => typeof value === "string");
  return { ...input, prompt };
}

function normalizeCodex(rawPayload) {
  if (rawPayload.tool_name !== "spawn_agent") return { ...rawPayload, agent: "codex" };
  return { ...rawPayload, tool_name: "Agent", tool_input: codexSpawnInput(rawPayload.tool_input), agent: "codex" };
}

export function fileChangesOf(payload) {
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (payload.tool_name === "apply_patch") {
    const workingDirectory = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    return patchFileChanges(toolInput.command, workingDirectory);
  }
  if (!FILE_TOOLS.has(payload.tool_name)) return [];
  return [{ tool_name: payload.tool_name, tool_input: toolInput }];
}

export function normalizePayload(rawPayload, agent = "claude") {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return rawPayload;
  if (agent === "agy") return normalizeAgy(rawPayload);
  if (agent === "codex") return normalizeCodex(rawPayload);
  return { ...rawPayload, agent };
}
