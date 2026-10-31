#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export const FIELD_SEPARATOR = " | ";

export function fieldValue(fields, label) {
  const prefix = `${label}:`;
  const field = fields.find((entry) => entry.trim().toLowerCase().startsWith(prefix));
  if (field === undefined) {
    return null;
  }
  return field.trim().slice(prefix.length).trim();
}

export function parseFinding(line) {
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
  const side = (fieldValue(fields, "side") ?? "RIGHT").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
  const lineNumber = /^\d+/.test(lineValue) ? Number(lineValue.match(/^\d+/)[0]) : null;
  return { filePath, lineNumber, side };
}

function findings(toolResponse) {
  const collectedText = [];
  collectText(toolResponse, collectedText);
  const lines = collectedText.join("\n").split(/\r?\n/);
  const blockStart = lines.findIndex((line) => line.trim() === "STRUCTURED_FINDINGS:");
  if (blockStart === -1) {
    return [];
  }

  const parsedFindings = [];
  for (const line of lines.slice(blockStart + 1)) {
    if (line.trim() === "OVERALL_SUMMARY:") {
      break;
    }
    const finding = parseFinding(line);
    if (finding === null) {
      continue;
    }
    parsedFindings.push(finding);
  }
  return parsedFindings;
}

function normalizeFilePath(filePath, workingDirectory) {
  const trimmedPath = filePath.trim();
  const relativePath = path.isAbsolute(trimmedPath)
    ? path.relative(workingDirectory, trimmedPath)
    : trimmedPath;
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function runGit(workingDirectory, argumentsList) {
  const processResult = spawnSync("git", argumentsList, {
    cwd: workingDirectory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (processResult.error || processResult.status !== 0) {
    throw processResult.error ?? new Error(processResult.stderr || "git command failed");
  }
  return processResult.stdout ?? "";
}

function gitPaths(workingDirectory, argumentsList) {
  return runGit(workingDirectory, [...argumentsList, "-z"]).split("\0").filter(Boolean);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function pushHunkRange(sideRanges, start, count) {
  if (count === 0) {
    return;
  }
  sideRanges.push([start, start + count - 1]);
}

const DIFF_ARGUMENTS = [
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--inter-hunk-context=0",
];

export function changedLineRanges(workingDirectory, filePath, diffRange = ["HEAD"]) {
  const ranges = { LEFT: [], RIGHT: [] };
  const diffOutput = runGit(workingDirectory, [...DIFF_ARGUMENTS, ...diffRange, "--", filePath]);
  let headerCount = 0;
  for (const line of diffOutput.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      continue;
    }
    headerCount += 1;
    pushHunkRange(ranges.LEFT, Number(header[1]), header[2] === undefined ? 1 : Number(header[2]));
    pushHunkRange(ranges.RIGHT, Number(header[3]), header[4] === undefined ? 1 : Number(header[4]));
  }
  if (headerCount === 0) {
    return null;
  }
  return ranges;
}

export function isWithinRanges(ranges, lineNumber) {
  return ranges.some(([start, end]) => lineNumber >= start && lineNumber <= end);
}

function describeScopeGaps(workingDirectory, parsedFindings) {
  const changedFiles = new Set(gitPaths(workingDirectory, ["diff", "--name-only", "HEAD"]));
  const untrackedFiles = new Set(
    gitPaths(workingDirectory, ["ls-files", "--others", "--exclude-standard"])
  );
  const rangesByFile = new Map();
  const outOfScopeFiles = new Set();
  const unchangedLines = new Set();

  for (const finding of parsedFindings) {
    const filePath = normalizeFilePath(finding.filePath, workingDirectory);
    if (untrackedFiles.has(filePath)) {
      continue;
    }
    if (!changedFiles.has(filePath)) {
      outOfScopeFiles.add(filePath);
      continue;
    }
    if (finding.lineNumber === null) {
      continue;
    }
    if (!rangesByFile.has(filePath)) {
      rangesByFile.set(filePath, changedLineRanges(workingDirectory, filePath));
    }
    const rangesForFile = rangesByFile.get(filePath);
    if (rangesForFile === null) {
      continue;
    }
    if (isWithinRanges(rangesForFile[finding.side], finding.lineNumber)) {
      continue;
    }
    unchangedLines.add(`${filePath}:${finding.lineNumber} (${finding.side})`);
  }

  return {
    outOfScopeFiles: [...outOfScopeFiles].sort(),
    unchangedLines: [...unchangedLines].sort(),
  };
}

function warn({ outOfScopeFiles, unchangedLines }) {
  const sentences = ["Scope check:"];
  if (outOfScopeFiles.length > 0) {
    sentences.push(
      "STRUCTURED_FINDINGS referenced files outside the current diff: " +
        `${outOfScopeFiles.join(", ")}. These files are not present in the working tree, ` +
        "staged diff, or untracked file list."
    );
  }
  if (unchangedLines.length > 0) {
    sentences.push(
      "STRUCTURED_FINDINGS anchored to lines the diff did not change: " +
        `${unchangedLines.join(", ")}. A finding on an unchanged line is out of scope unless ` +
        "its body attributes the defect to a changed line."
    );
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: sentences.join(" "),
      },
    })
  );
  process.exit(0);
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (!SPAWN_TOOLS.has(payload.tool_name)) allow();

  const parsedFindings = findings(payload.tool_response);
  if (parsedFindings.length === 0) allow();

  const workingDirectory =
    typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  const scopeGaps = describeScopeGaps(workingDirectory, parsedFindings);
  if (scopeGaps.outOfScopeFiles.length === 0 && scopeGaps.unchangedLines.length === 0) allow();
  warn(scopeGaps);
}

const isRunDirectly = Boolean(process.argv[1]) && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isRunDirectly) {
  try {
    main();
  } catch {
    allow();
  }
}
