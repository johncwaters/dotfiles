import { readFileSync } from "node:fs";
import { isObject } from "./lib/ledger.ts";
import { validateRetroReport, validateRetroRun } from "./lib/report.ts";

try {
  const filePath = process.argv[2];
  if (!filePath || process.argv.length !== 3) throw new Error("supply one report JSON file path");
  const parsedInput: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const isRunFile = isObject(parsedInput) && Object.hasOwn(parsedInput, "report");
  const errors = isRunFile ? validateRetroRun(parsedInput) : validateRetroReport(parsedInput);
  process.stdout.write(`${JSON.stringify({ outcome: errors.length ? "INVALID" : "VALID", errors })}\n`);
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: "UNREADABLE", errors: [error instanceof Error ? error.message : String(error)] })}\n`);
  process.exitCode = 2;
}
