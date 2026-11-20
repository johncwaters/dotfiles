import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { namingSyntaxFor, scanVagueNameLines } from "./name-scanner.mjs";
import { isPathOwned } from "./repo-ownership.mjs";
import { denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.slice(0, 100)}`);
  denyPreToolUse([
    `Naming guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new binding(s) named data, tmp, temp, info, result, res, val, obj, or a single letter:`,
    ...shown,
    "Fix: name what the value is in domain words (remainingRetryBudget, parsedInvoice); i and j pass only as for-loop counters, _ passes as a discard and $ as a framework handle.",
    "Destructured names pass, since they mirror the source's own field names.",
  ].join("\n"));
}

runGrowthGuard({
  syntaxFor: namingSyntaxFor,
  scanLines: scanVagueNameLines,
  deny,
  isPathInScope: (filePath) => isPathOwned(path.resolve(filePath)),
});
