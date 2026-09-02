import fs from "node:fs";

export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export function allow() {
  process.exit(0);
}

export function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

export function denyPreToolUse(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
