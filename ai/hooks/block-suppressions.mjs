import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { suppressionSyntaxFor, scanSuppressionLines } from "./comment-scanner.mjs";
import { denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `Suppression guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new check suppression(s) or focused or skipped test(s):`,
    ...shown,
    "Fix: find the root cause of the lint, type, or test failure and fix it instead of silencing the check.",
    "A workaround a real upstream blocker forces passes when the suppression's own line links the upstream issue (an http(s) URL) and names the removal trigger.",
  ].join("\n"));
}

runGrowthGuard({ syntaxFor: suppressionSyntaxFor, scanLines: scanSuppressionLines, deny });
