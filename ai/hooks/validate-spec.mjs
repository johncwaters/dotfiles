import fs from "node:fs";
import path from "node:path";
import { replayEdits } from "./edit-replay.mjs";
import { fileChangesOf } from "./agent-payload.mjs";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";
import { validateGraph } from "../skills/specifying/lib/graph.ts";
import { specsDirectory } from "../skills/specifying/lib/spec-store.ts";

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

function judgeSpecChange(change) {
  const toolInput = change.tool_input;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return;
  const filePath = toolInput.file_path || toolInput.filePath;
  if (typeof filePath !== "string" || !filePath.endsWith(".json")) return;
  const absolutePath = path.resolve(filePath);
  const resolvedSpecsDirectory = resolveExistingPath(specsDirectory());
  const resolvedPath = resolveExistingPath(absolutePath);
  const relativePath = path.relative(resolvedSpecsDirectory, resolvedPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return;
  if (typeof toolInput.content !== "string") {
    if (change.tool_name === "Write") return;
    if (toolInput.edits !== undefined && (!Array.isArray(toolInput.edits) || toolInput.edits.length === 0 || !toolInput.edits.every(hasValidEdit))) return;
    if (toolInput.edits === undefined && !hasValidEdit(toolInput)) return;
  }
  const isExistingSpec = fs.existsSync(absolutePath);
  if (isExistingSpec) fs.readFileSync(absolutePath, "utf8");
  const { content, hasUnmatchedOldString } = replayEdits(toolInput, absolutePath);
  if (typeof content !== "string") return;
  if (isExistingSpec && hasUnmatchedOldString) {
    denyPreToolUse(`Design spec guard cannot validate this edit: old_string is absent from ${absolutePath} byte for byte. Re-read the file and copy the exact text into old_string.`);
  }
  const parsedSpec = JSON.parse(content);
  const errors = validateGraph(parsedSpec);
  if (errors.length === 0) return;
  const reasonLines = errors.slice(0, 20);
  if (errors.length > 20) reasonLines.push(`${errors.length - 20} more errors; they show on the next write once these are fixed.`);
  denyPreToolUse(reasonLines.join("\n"));
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  for (const change of fileChangesOf(payload)) judgeSpecChange(change);
  allow();
} catch {
  allow();
}
