import fs from "node:fs";
import { replayEdits } from "./edit-replay.mjs";
import { commentLinesOnlyInAfter } from "./comment-scanner.mjs";
import { fileChangesOf } from "./agent-payload.mjs";
import { allow, readPayload } from "./hook-io.mjs";

function readBaseline(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (readError) {
    if (readError?.code === "ENOENT") return "";
    return null;
  }
}

function compareDocuments(before, after, syntax, scanLines) {
  const beforeLines = scanLines(before, syntax);
  const afterLines = scanLines(after, syntax);
  return {
    added: afterLines.length - beforeLines.length,
    samples: commentLinesOnlyInAfter(beforeLines, afterLines),
  };
}

function judgeWrite(toolInput, syntax, scanLines) {
  const before = readBaseline(toolInput.baseline_path ?? toolInput.file_path);
  if (before === null) return null;
  const content = typeof toolInput.content === "string" ? toolInput.content : "";
  return compareDocuments(before, content, syntax, scanLines);
}

function editsOf(toolInput) {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  return edits.filter((edit) => edit && typeof edit === "object");
}

function judgeFragments(edits, syntax, scanLines) {
  let added = 0;
  const samples = [];
  for (const edit of edits) {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : "";
    const fragment = compareDocuments(oldString, newString, syntax, scanLines);
    added += fragment.added;
    samples.push(...fragment.samples);
  }
  return { added, samples };
}

function samplesSuppliedByCall(toolInput, samples) {
  const supplied = [
    typeof toolInput.content === "string" ? toolInput.content : "",
    ...editsOf(toolInput).map((edit) =>
      typeof edit.new_string === "string" ? edit.new_string : "",
    ),
  ].join("\n");
  return samples.filter((line) => supplied.includes(line));
}

function judgeEdits(toolInput, syntax, scanLines) {
  const edits = editsOf(toolInput);
  const baseline = readBaseline(toolInput.file_path);
  if (baseline === null) return null;
  if (baseline === "" || edits.some((edit) => typeof edit.old_string !== "string" || edit.old_string === "")) {
    return judgeFragments(edits, syntax, scanLines);
  }
  const replay = replayEdits({ edits }, toolInput.file_path, { shouldFlagUnmatchedReplaceAll: false });
  if (replay.hasUnmatchedOldString) return judgeFragments(edits, syntax, scanLines);
  return compareDocuments(baseline, replay.content, syntax, scanLines);
}

function hasValidEditStrings(edit) {
  return edit && typeof edit === "object" &&
    typeof edit.old_string === "string" && typeof edit.new_string === "string";
}

function isJudgeableChange(change) {
  const toolInput = change.tool_input;
  if (!toolInput || typeof toolInput !== "object" || typeof toolInput.file_path !== "string") return false;
  if (change.tool_name === "Write") return typeof toolInput.content === "string";
  if (change.tool_name === "Edit") return hasValidEditStrings(toolInput);
  return Array.isArray(toolInput.edits) && toolInput.edits.every(hasValidEditStrings);
}

function judgeChange(change, syntax, scanLines) {
  const toolInput = change.tool_input;
  if (change.tool_name === "Write") return judgeWrite(toolInput, syntax, scanLines);
  return judgeEdits(toolInput, syntax, scanLines) ?? judgeFragments(editsOf(toolInput), syntax, scanLines);
}

function runGrowthGuard({ syntaxFor, scanLines, deny }) {
  try {
    const payload = readPayload();
    if (!payload || typeof payload !== "object") allow();
    let added = 0;
    let firstGrowingPath = "";
    const samples = [];
    for (const change of fileChangesOf(payload)) {
      if (!isJudgeableChange(change)) continue;
      const syntax = syntaxFor(change.tool_input.file_path);
      if (!syntax) continue;
      const judgement = judgeChange(change, syntax, scanLines);
      if (!judgement || judgement.added <= 0) continue;
      added += judgement.added;
      firstGrowingPath ||= change.tool_input.file_path;
      samples.push(...samplesSuppliedByCall(change.tool_input, judgement.samples));
    }
    if (added > 0) deny(firstGrowingPath, added, samples);
    allow();
  } catch {
    allow();
  }
}

export { judgeWrite, judgeEdits, judgeFragments, samplesSuppliedByCall, runGrowthGuard };
