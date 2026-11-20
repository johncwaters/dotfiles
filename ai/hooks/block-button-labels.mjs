import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { buttonLabelSyntaxFor, scanStatefulButtonLines, statefulButtonReason } from "./comment-scanner.mjs";
import { denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((sample) => `  ${statefulButtonReason(sample)}: ${sample.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  denyPreToolUse([
    `Button-label guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} button(s) whose label carries state:`,
    ...shown,
    "Fix: give the control one constant action label; disable it while busy and render the spinner, progress text, count, or outcome as a sibling outside the button.",
    "Existing buttons are not counted; there is no escape comment.",
  ].join("\n"));
}

runGrowthGuard({ syntaxFor: buttonLabelSyntaxFor, scanLines: scanStatefulButtonLines, deny });
