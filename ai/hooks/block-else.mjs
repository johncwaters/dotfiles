import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { elseSyntaxFor, scanElseLines } from "./comment-scanner.mjs";
import { denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `No-else guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new else statement(s):`,
    ...shown,
    "Fix: invert the condition and return, continue, break, or throw early; replace else-if chains with guard clauses, a lookup map, or a switch with early returns.",
    "Ternaries, Rust let-else, Python for/while/try/except else, and Ruby begin/rescue else are exempt.",
  ].join("\n"));
}

runGrowthGuard({ syntaxFor: elseSyntaxFor, scanLines: scanElseLines, deny });
