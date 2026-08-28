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
    const finding = /^\s*-\s+file:\s*(.*?)\s+\|\s+line:/i.exec(line);
    if (!finding?.[1]) {
      continue;
    }
    files.push(finding[1]);
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
