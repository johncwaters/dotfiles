import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runGrowthGuard } from "../../hooks/edit-judge.mjs";
import { useEffectSyntaxFor } from "../../hooks/comment-scanner.mjs";
import { denyPreToolUse } from "../../hooks/hook-io.mjs";

const STATE_HOOK_RE = /\buseState\b/g;
const QUOTED_SPAN_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

export function scanUseStateLines(content) {
  const found = [];
  for (const line of String(content).split("\n")) {
    const code = line.replace(QUOTED_SPAN_RE, "''").replace(/\/\/.*$/, "");
    found.push(...Array.from(code.matchAll(STATE_HOOK_RE), () => line.trim()));
  }
  return found;
}

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `No-useState guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new useState call(s):`,
    ...shown,
    "Fix: hold component state in useReducer with a typed action union, and derive values during render.",
    "Existing calls are not counted; there is no escape comment.",
  ].join("\n"));
}

const isRunAsHook = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isRunAsHook) runGrowthGuard({ syntaxFor: useEffectSyntaxFor, scanLines: scanUseStateLines, deny });
