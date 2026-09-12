#!/usr/bin/env node
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";

const STAMP_COUNTS = /^challenge:\s*\d+\s+kept\b/i;
const LEADING_DECORATION = new Set([" ", "\t", "#", ">", "-", "*", "+", "_", "`"]);
const TRAILING_DECORATION = new Set([" ", "\t", "\r", "*", "_", "`"]);

function finalNonEmptyLine(plan) {
  const lines = plan.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === "") index -= 1;
  if (index < 0) return "";
  return lines[index];
}

function stripDecoration(line) {
  let start = 0;
  let end = line.length;
  while (start < end && LEADING_DECORATION.has(line[start])) start += 1;
  while (end > start && TRAILING_DECORATION.has(line[end - 1])) end -= 1;
  return line.slice(start, end);
}

function isStamped(plan) {
  return STAMP_COUNTS.test(stripDecoration(finalNonEmptyLine(plan)));
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (payload.tool_name !== "ExitPlanMode") allow();

  const input = payload.tool_input;
  if (!input || typeof input !== "object") allow();

  const plan = typeof input.plan === "string" ? input.plan : "";
  if (plan.trim() === "") allow();
  if (isStamped(plan)) allow();

  denyPreToolUse(
    "Unchallenged plan: every plan gets adversarially simplified before it " +
      "leaves plan mode. Invoke the plan-challenge skill (Skill tool, skill: " +
      '"plan-challenge"), let its three challengers argue against each step, ' +
      "apply the verdicts, then re-call ExitPlanMode with the revised plan " +
      "ending in its CHALLENGE: stamp line. A context that cannot spawn " +
      "agents returns the plan to its caller unstamped instead of exiting " +
      "plan mode."
  );
}

try {
  main();
} catch {
  allow();
}
