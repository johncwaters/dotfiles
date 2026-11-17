import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { judgeEdits, judgeWrite } from "../../hooks/edit-judge.mjs";
import { commentLinesOnlyInAfter, useEffectSyntaxFor } from "../../hooks/comment-scanner.mjs";
export { commentLinesOnlyInAfter };
import { allow, denyPreToolUse, readPayload } from "../../hooks/hook-io.mjs";

const STATE_HOOK_RE = /\buseState\b/g;
const IMPORT_LINE_RE = /^\s*import\b/;
const QUOTED_SPAN_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

export function scanUseStateLines(content) {
  const found = [];
  for (const line of String(content).split("\n")) {
    if (IMPORT_LINE_RE.test(line)) continue;
    const code = line.replace(QUOTED_SPAN_RE, "''").replace(/\/\/.*$/, "");
    found.push(...Array.from(code.matchAll(STATE_HOOK_RE), () => line.trim()));
  }
  return found;
}

const GUARDED_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function denyAddedState(filePath, addedLines) {
  denyPreToolUse([
    `No-useState guard blocked this write to ${path.basename(filePath)}.`,
    "Why: it writes useState line(s) the file did not have before:",
    ...addedLines.slice(0, 3).map((line) => `  ${line.slice(0, 100)}`),
    "Fix: hold the state this change adds in useReducer with a typed action union, and derive values during render.",
  ].join("\n"));
}

function denyRemovedState(filePath, removedCount) {
  denyPreToolUse([
    `No-useState guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it removes ${removedCount} existing useState reference(s); converting existing state is out of scope.`,
    "Fix: leave every existing useState call exactly as it is and apply the rule only to state this change adds.",
  ].join("\n"));
}

function judgeStateCountChange() {
  const payload = readPayload();
  const toolInput = payload?.tool_input;
  if (!GUARDED_TOOLS.has(payload?.tool_name) || typeof toolInput?.file_path !== "string") allow();
  const syntax = useEffectSyntaxFor(toolInput.file_path);
  if (!syntax) allow();
  const judge = payload.tool_name === "Write" ? judgeWrite : judgeEdits;
  const judgement = judge(toolInput, syntax, scanUseStateLines);
  if (judgement?.samples?.length > 0) denyAddedState(toolInput.file_path, judgement.samples);
  if (judgement?.added < 0) denyRemovedState(toolInput.file_path, -judgement.added);
  allow();
}

const isRunAsHook = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isRunAsHook) {
  try {
    judgeStateCountChange();
  } catch {
    allow();
  }
}
