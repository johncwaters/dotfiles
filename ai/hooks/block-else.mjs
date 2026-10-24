import path from "node:path";
import { judgeWrite, judgeEdits, judgeFragments, samplesSuppliedByCall } from "./edit-judge.mjs";
import { elseSyntaxFor, scanElseLines } from "./comment-scanner.mjs";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `No-else guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new else statement(s):`,
    ...shown,
    "Fix: invert the condition and return, continue, break, or throw early; replace else-if chains with guard clauses, a lookup map, or a switch with early returns.",
    "Ternaries, Rust let-else, Python for/while/try/except else, and Ruby begin/rescue else are exempt.",
  ].join("\n"));
}

function startHunk(patchFile) {
  const hunk = { beforeLines: [], afterLines: [] };
  patchFile.hunks.push(hunk);
  return hunk;
}

function splitPatch(command) {
  if (typeof command !== "string") return null;
  const lines = command.trim().split(/\r?\n/);
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
    if (/^@@(?: .*|)$/.test(line)) {
      if (currentFile.operation !== "Update") return null;
      currentHunk = startHunk(currentFile);
      continue;
    }
    if (line === "*** End of File") {
      if (currentFile.operation !== "Update") return null;
      currentFile.hasEnded = true;
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

function judgePatchedFile(patchFile, syntax, workingDirectory) {
  const edits = patchFile.hunks.map((hunk) => ({
    old_string: hunk.beforeLines.join("\n"),
    new_string: hunk.afterLines.join("\n"),
  }));
  if (patchFile.operation !== "Update") return judgeFragments(edits, syntax, scanElseLines);
  const targetPath = path.resolve(workingDirectory, patchFile.sourcePath);
  return judgeEdits({ file_path: targetPath, edits }, syntax, scanElseLines) ??
    judgeFragments(edits, syntax, scanElseLines);
}

function judgePatch(command, workingDirectory) {
  const files = splitPatch(command);
  if (!files) return null;
  let added = 0;
  let filePath = "";
  const samples = [];
  for (const patchFile of files) {
    if (patchFile.operation === "Delete") continue;
    const syntax = elseSyntaxFor(patchFile.file_path);
    if (!syntax) continue;
    const judgement = judgePatchedFile(patchFile, syntax, workingDirectory);
    if (judgement.added <= 0) continue;
    added += judgement.added;
    if (!filePath) filePath = patchFile.file_path;
    samples.push(...judgement.samples);
  }
  return { added, samples, filePath };
}

function hasValidEditStrings(edit) {
  return edit && typeof edit === "object" &&
    typeof edit.old_string === "string" && typeof edit.new_string === "string";
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") allow();
  if (payload.tool_name === "apply_patch") {
    const workingDirectory = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const judgement = judgePatch(toolInput.command, workingDirectory);
    if (judgement?.added > 0) deny(judgement.filePath, judgement.added, judgement.samples);
    allow();
  }
  if (!["Write", "Edit", "MultiEdit"].includes(payload.tool_name)) allow();
  if (typeof toolInput.file_path !== "string") allow();
  const syntax = elseSyntaxFor(toolInput.file_path);
  if (!syntax) allow();
  if (payload.tool_name === "Write" && typeof toolInput.content !== "string") allow();
  if (payload.tool_name === "Edit" && !hasValidEditStrings(toolInput)) allow();
  if (payload.tool_name === "MultiEdit" &&
      (!Array.isArray(toolInput.edits) || !toolInput.edits.every(hasValidEditStrings))) allow();
  const judge = payload.tool_name === "Write" ? judgeWrite : judgeEdits;
  const judgement = judge(toolInput, syntax, scanElseLines);
  if (judgement?.added > 0) {
    deny(toolInput.file_path, judgement.added, samplesSuppliedByCall(toolInput, judgement.samples));
  }
  allow();
} catch {
  allow();
}
