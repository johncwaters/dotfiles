import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayEdits } from "./edit-replay.mjs";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";
import { validateGraph } from "../skills/specifying/lib/graph.ts";

function resolveExistingPath(filePath) {
  if (fs.existsSync(filePath)) return fs.realpathSync(filePath);
  const parentPath = path.dirname(filePath);
  if (parentPath === filePath) return filePath;
  return path.join(resolveExistingPath(parentPath), path.basename(filePath));
}

function hasValidEdit(edit) {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
  if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") return false;
  return edit.replace_all === undefined || typeof edit.replace_all === "boolean";
}

try {
  const payload = readPayload();
  if (!payload || !["Write", "Edit", "MultiEdit"].includes(payload.tool_name)) allow();
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) allow();
  const filePath = toolInput.file_path || toolInput.filePath;
  if (typeof filePath !== "string" || !filePath.endsWith(".json")) allow();
  const absolutePath = path.resolve(filePath);
  const specsDirectory = resolveExistingPath(path.join(os.homedir(), ".claude", "specs"));
  const resolvedPath = resolveExistingPath(absolutePath);
  const relativePath = path.relative(specsDirectory, resolvedPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) allow();
  if (typeof toolInput.content !== "string") {
    if (payload.tool_name === "Write") allow();
    if (toolInput.edits !== undefined && (!Array.isArray(toolInput.edits) || toolInput.edits.length === 0 || !toolInput.edits.every(hasValidEdit))) allow();
    if (toolInput.edits === undefined && !hasValidEdit(toolInput)) allow();
  }
  const isExistingSpec = fs.existsSync(absolutePath);
  if (isExistingSpec) fs.readFileSync(absolutePath, "utf8");
  const { content, hasUnmatchedOldString } = replayEdits(toolInput, absolutePath);
  if (typeof content !== "string") allow();
  if (isExistingSpec && hasUnmatchedOldString) {
    denyPreToolUse(`Design spec guard cannot validate this edit: old_string is absent from ${absolutePath} byte for byte. Re-read the file and copy the exact text into old_string.`);
  }
  const parsedSpec = JSON.parse(content);
  const errors = validateGraph(parsedSpec);
  if (errors.length === 0) allow();
  const reasonLines = errors.slice(0, 20);
  if (errors.length > 20) reasonLines.push(`${errors.length - 20} more errors; they show on the next write once these are fixed.`);
  denyPreToolUse(reasonLines.join("\n"));
} catch {
  allow();
}
