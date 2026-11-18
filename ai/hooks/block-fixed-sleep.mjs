import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { fixedSleepSyntaxFor, scanFixedSleepLines } from "./comment-scanner.mjs";
import { allow, denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  if (samples.length === 0) allow();
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `No-fixed-sleep guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new fixed-delay wait(s) followed by an assertion, which pass on a fast machine and flake on a slow runner:`,
    ...shown,
    "Fix: await the operation itself or a signal it emits (the promise it returns, an event, a recorded call resolving a deferred), then assert.",
    "Sleeps inside while/for poll loops and existing sleeps are not counted; there is no escape comment.",
  ].join("\n"));
}

runGrowthGuard({ syntaxFor: fixedSleepSyntaxFor, scanLines: scanFixedSleepLines, deny });
