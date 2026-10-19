import fs from "node:fs";
import path from "node:path";

export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export const COMMAND_START = String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:then|do|else)\b|\b(?:ba|z|da)?sh\s+(?:-\S+\s+)*-c\s+)`;
export const COMMAND_WRAPPERS = String.raw`(?:[A-Za-z_]\w*=\S*\s+|(?:\S*/)?(?:xargs|time|sudo|nice|nohup|exec|command|env|timeout|stdbuf|eval|watch|npx|bunx|npm\s+(?:exec|x)|bun\s+x|pnpm\s+dlx|yarn\s+dlx)(?:\s+(?:-[A-Za-z]\s+[^-\s]\S*|-\S+|\S+=\S*|\d+\S*))*\s+)*`;

export function isAttendedMainLoopCall(payload) {
  return process.env.CLAUDE_CODE_SESSION_ATTENDED === "1" && !payload.agent_id;
}

export function nearestExistingDirectory(filePath) {
  let candidate = path.dirname(filePath);
  while (!fs.existsSync(candidate) && candidate !== path.dirname(candidate)) candidate = path.dirname(candidate);
  return candidate;
}

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

function decidePreToolUse(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

export function denyPreToolUse(reason) {
  decidePreToolUse("deny", reason);
}

export function askPreToolUse(reason) {
  decidePreToolUse("ask", reason);
}
