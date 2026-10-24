import fs from "node:fs";
import { replayEdits } from "./edit-replay.mjs";
import { commentLinesOnlyInAfter } from "./comment-scanner.mjs";

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
  const before = readBaseline(toolInput.file_path);
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

export { judgeWrite, judgeEdits, judgeFragments, samplesSuppliedByCall };
