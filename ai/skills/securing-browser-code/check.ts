import path from "node:path";
import { type AuditReport, auditBrowserCode, formatFailure, runGitIn } from "./lib/audit.ts";

const USAGE = "usage: check.ts [--json] [repo]";
const AUDIT_CRASHED_EXIT_CODE = 3;

const commandArguments = process.argv.slice(2);
const printsJson = commandArguments.includes("--json");
const positionalArguments = commandArguments.filter((argument) => argument !== "--json");
if (positionalArguments.length > 1 || positionalArguments.some((argument) => argument.startsWith("-"))) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const startDirectory = path.resolve(positionalArguments[0] ?? ".");
const topLevel = runGitIn(startDirectory, ["rev-parse", "--show-toplevel"]);
if (topLevel.code !== 0) {
  process.stderr.write(`${startDirectory} is not inside a git repository\n${USAGE}\n`);
  process.exit(2);
}

const report = auditOrExit(topLevel.stdout.trim());
if (printsJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.failures.length > 0 ? 1 : 0);
}
if (!report.applies) {
  process.stdout.write("skipped: no third-party browser code\n");
  process.exit(0);
}
for (const failure of report.failures) process.stdout.write(`${formatFailure(failure)}\n`);
const sdkSummary = report.sdks.length > 0 ? report.sdks.join(", ") : "none";
process.stdout.write(`${report.failures.length} failing, ${report.waived.length} waived; SDK modules: ${sdkSummary}\n`);
for (const liveNote of report.liveNotes) process.stdout.write(`${liveNote}\n`);
process.exit(report.failures.length > 0 ? 1 : 0);

function auditOrExit(repoRoot: string): AuditReport {
  try {
    return auditBrowserCode(repoRoot);
  } catch (error) {
    process.stderr.write(`audit crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(AUDIT_CRASHED_EXIT_CODE);
  }
}
