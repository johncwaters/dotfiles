#!/usr/bin/env node
import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { denyPreToolUse } from "./hook-io.mjs";
import { scanCommentLines, syntaxFor } from "./comment-scanner.mjs";
import { isPathOwned } from "./repo-ownership.mjs";

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

runGrowthGuard({
  syntaxFor,
  scanLines: scanCommentLines,
  deny,
  isPathInScope: (filePath) => isPathOwned(path.resolve(filePath)),
});
