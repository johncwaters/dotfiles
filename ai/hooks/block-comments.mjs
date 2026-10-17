#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { replayEdits } from "./edit-replay.mjs";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";
import { commentLinesOnlyInAfter, scanCommentLines, syntaxFor } from "./comment-scanner.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.slice(0, 100)}`);
  const why =
    shown.length > 0
      ? [`Why: it adds ${addedCount} net-new comment line(s):`, ...shown]
      : [`Why: it adds ${addedCount} net-new comment line(s).`];
  denyPreToolUse([
    `No-comments guard blocked this write to ${path.basename(String(filePath))}.`,
    ...why,
    "Fix: delete the comment(s) and put the intent into names and structure instead.",
    "JSDoc @tag lines with their /** and */ delimiters, and the shebang line, are exempt; rewriting or deleting existing comments always passes.",
    "If a why-comment is genuinely load-bearing (external anchor, cross-file invariant), ask the operator to add it themselves.",
  ].join("\n"));
}

function readBaseline(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (readError) {
    if (readError?.code === "ENOENT") return "";
    return null;
  }
}

function compareDocuments(before, after, syntax) {
  const beforeComments = scanCommentLines(before, syntax);
  const afterComments = scanCommentLines(after, syntax);
  return {
    added: afterComments.length - beforeComments.length,
    samples: commentLinesOnlyInAfter(beforeComments, afterComments),
  };
}

function judgeWrite(toolInput, syntax) {
  const before = readBaseline(toolInput.file_path);
  if (before === null) return null;
  const content = typeof toolInput.content === "string" ? toolInput.content : "";
  return compareDocuments(before, content, syntax);
}

function editsOf(toolInput) {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  return edits.filter((edit) => edit && typeof edit === "object");
}

function judgeFragments(edits, syntax) {
  let added = 0;
  const samples = [];
  for (const edit of edits) {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : "";
    const fragment = compareDocuments(oldString, newString, syntax);
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

function judgeEdits(toolInput, syntax) {
  const edits = editsOf(toolInput);
  const baseline = readBaseline(toolInput.file_path);
  if (baseline === null) return null;
  if (baseline === "" || edits.some((edit) => typeof edit.old_string !== "string" || edit.old_string === "")) {
    return judgeFragments(edits, syntax);
  }
  const replay = replayEdits({ edits }, toolInput.file_path, { shouldFlagUnmatchedReplaceAll: false });
  if (replay.hasUnmatchedOldString) return judgeFragments(edits, syntax);
  return compareDocuments(baseline, replay.content, syntax);
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const toolName = payload.tool_name;
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (typeof toolInput.file_path !== "string") allow();
  const syntax = syntaxFor(toolInput.file_path);
  if (!syntax) allow();
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") allow();
  const judge = toolName === "Write" ? judgeWrite : judgeEdits;
  const judgement = judge(toolInput, syntax);
  if (judgement && judgement.added > 0) {
    deny(toolInput.file_path, judgement.added, samplesSuppliedByCall(toolInput, judgement.samples));
  }
  allow();
} catch {
  allow();
}
