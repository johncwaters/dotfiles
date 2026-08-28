#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { allow, readPayload, SPAWN_TOOLS } from "./hook-io.mjs";

function collectText(value, collectedText) {
  if (typeof value === "string") {
    collectedText.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, collectedText);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const nestedValue of Object.values(value)) {
    collectText(nestedValue, collectedText);
  }
}

const FIELD_SEPARATOR = " | ";

function fieldValue(fields, label) {
  const prefix = `${label}:`;
  const field = fields.find((entry) => entry.trim().toLowerCase().startsWith(prefix));
  if (field === undefined) {
    return null;
  }
  return field.trim().slice(prefix.length).trim();
}

function findingFilePath(line) {
  const trimmedLine = line.trim();
  if (!trimmedLine.startsWith("-")) {
    return null;
  }
  const fields = trimmedLine.slice(1).split(FIELD_SEPARATOR);
  const lineValue = fieldValue(fields, "line");
  if (lineValue === null || !/^(?:\d+|general)\b/i.test(lineValue)) {
    return null;
  }
  const filePath = fieldValue(fields, "file");
  if (!filePath || filePath === "(none)" || /^<.*>$/.test(filePath)) {
    return null;
  }
  return filePath;
}

function findingFiles(toolResponse) {
  const collectedText = [];
  collectText(toolResponse, collectedText);
  const lines = collectedText.join("\n").split(/\r?\n/);
  const blockStart = lines.findIndex((line) => line.trim() === "STRUCTURED_FINDINGS:");
  if (blockStart === -1) {
    return [];
  }

  const files = [];
  for (const line of lines.slice(blockStart + 1)) {
    if (line.trim() === "OVERALL_SUMMARY:") {
      break;
    }
    const filePath = findingFilePath(line);
    if (filePath === null) {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

function normalizeFilePath(filePath, workingDirectory) {
  const trimmedPath = filePath.trim();
  const relativePath = path.isAbsolute(trimmedPath)
    ? path.relative(workingDirectory, trimmedPath)
    : trimmedPath;
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function gitPaths(workingDirectory, argumentsList) {
  const processResult = spawnSync("git", [...argumentsList, "-z"], {
    cwd: workingDirectory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (processResult.error || processResult.status !== 0) {
    throw processResult.error ?? new Error(processResult.stderr || "git command failed");
  }
  return (processResult.stdout ?? "").split("\0").filter(Boolean);
}

function warn(outOfScopeFiles) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "Scope check: STRUCTURED_FINDINGS referenced files outside the current diff: " +
          `${outOfScopeFiles.join(", ")}. These files are not present in the working tree, ` +
          "staged diff, or untracked file list.",
      },
    })
  );
  process.exit(0);
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (!SPAWN_TOOLS.has(payload.tool_name)) allow();

  const files = findingFiles(payload.tool_response);
  if (files.length === 0) allow();

  const workingDirectory =
    typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  const changedFiles = new Set([
    ...gitPaths(workingDirectory, ["diff", "--name-only", "HEAD"]),
    ...gitPaths(workingDirectory, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const outOfScopeFiles = [
    ...new Set(
      files
        .map((filePath) => normalizeFilePath(filePath, workingDirectory))
        .filter((filePath) => !changedFiles.has(filePath))
    ),
  ].sort();
  if (outOfScopeFiles.length === 0) allow();
  warn(outOfScopeFiles);
}

try {
  main();
} catch {
  allow();
}
