#!/usr/bin/env node
/**
 * PreToolUse guard for Write / Edit / MultiEdit that DENIES a tool call which
 * would add net-new comment lines to a code file. Seeded onto a fresh machine
 * from glissa/config.example.json (config.json `hooks`) and edited per-session
 * through the Glissa Hooks tab, NOT through ~/.claude/settings.json, so it
 * applies only to Glissa-spawned agent sessions.
 *
 * What counts: full lines that are comments (line markers `//`, `#`, `--`, and
 * block comments opening at line start) outside string regions (JS template
 * literals, Python triple-quoted strings, shell heredoc bodies), whose openers are
 * read only from the code before a trailing comment. What is exempt: the shebang
 * line, and inside a `/**` block its bare delimiters and `@tag` lines (type
 * machinery the typecheck gates depend on); its prose lines still count. Accepted
 * under-blocks: trailing comments after code, a `#` glued to the word before it
 * (`url#frag`), a backtick inside a JS regex literal, and a shell left shift by a
 * bare name (`$((1 << width))`), which still reads as a heredoc opener.
 *
 * The decision compares counts, not absolutes: a Write is judged against the file
 * currently on disk, an Edit against that same file with its edits applied, and
 * only against its own old_string when the file is absent or the fragment does
 * not occur in it. So deleting, moving, or rewriting existing comments always
 * passes. Only growth denies, and the reason quotes only lines the call itself
 * supplied, falling back to a bare count when the denied line came from disk.
 *
 * Fail open (shared rule of this directory): any error, unreadable payload, or
 * unknown file type MUST allow. Node built-ins only, synchronous, pure ASCII.
 */

import fs from "node:fs";
import path from "node:path";
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

function applyEdit(document, edit) {
  const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
  const newString = typeof edit.new_string === "string" ? edit.new_string : "";
  if (oldString === "") return null;
  if (edit.replace_all === true) return document.split(oldString).join(newString);
  const at = document.indexOf(oldString);
  if (at < 0) return null;
  return document.slice(0, at) + newString + document.slice(at + oldString.length);
}

function applyEdits(document, edits) {
  let applied = document;
  for (const edit of edits) {
    const next = applyEdit(applied, edit);
    if (next === null) return null;
    applied = next;
  }
  return applied;
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
  const edited = baseline === "" ? null : applyEdits(baseline, edits);
  if (edited === null) return judgeFragments(edits, syntax);
  return compareDocuments(baseline, edited, syntax);
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
