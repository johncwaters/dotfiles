import fs from "node:fs";

export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export const DIRECT_WORK_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "WebSearch",
]);

const EXPLORE_DELEGATION_NEXT_CALL =
  'Next call: an `Agent` call with `subagent_type: "Explore"`.';

const CODEX_DELEGATION_NEXT_CALL =
  "Next call: a Bash `codex exec --dangerously-bypass-approvals-and-sandbox " +
  "-m <Codex id per ROUTING.md rule 1> <<'EOF'` dispatch with the prompt inline and " +
  "`run_in_background: true`, or an `Agent` call.";

const GROK_DELEGATION_NEXT_CALL =
  "Next call: a Bash `grok -p '<prompt>' --always-approve` dispatch with " +
  "`run_in_background: true`, or an `Agent` call.";

export const DELEGATION_NEXT_CALL_BY_TOOL = new Map([
  ["Read", EXPLORE_DELEGATION_NEXT_CALL],
  ["Grep", EXPLORE_DELEGATION_NEXT_CALL],
  ["Glob", EXPLORE_DELEGATION_NEXT_CALL],
  ["Edit", CODEX_DELEGATION_NEXT_CALL],
  ["Write", CODEX_DELEGATION_NEXT_CALL],
  ["MultiEdit", CODEX_DELEGATION_NEXT_CALL],
  ["NotebookEdit", CODEX_DELEGATION_NEXT_CALL],
  ["Bash", CODEX_DELEGATION_NEXT_CALL],
  ["WebFetch", GROK_DELEGATION_NEXT_CALL],
  ["WebSearch", GROK_DELEGATION_NEXT_CALL],
]);

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
