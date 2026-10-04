#!/usr/bin/env node
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";
import { buildCodexReviewSandboxProfile } from "../protected-paths.mjs";

const DISPATCHER_AGENT_TYPE = "codex-dispatcher";

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REVIEW_SANDBOX_OPTIONS =
  `-c ${buildCodexReviewSandboxProfile()} ` +
  `-c 'default_permissions="qa_review"'`;
const SAFE_ABSOLUTE_PATH = "/[A-Za-z0-9._/@+-]*";
const PROMPT_STEM = "/tmp/codex-dispatch-[A-Za-z0-9._-]+";
const PROMPT_FILE_PATH = `${PROMPT_STEM}\\.txt`;
const SANCTIONED_DISPATCH_COMMAND = new RegExp(
  `^codex exec ${escapeRegExp(REVIEW_SANDBOX_OPTIONS)} -C ${SAFE_ABSOLUTE_PATH} -m (?:gpt-6\\.1-sol|gpt-6-luna|gpt-6-astra)` +
    `(?: -c model_reasoning_effort="(?:low|medium|high|xhigh)")? < (${PROMPT_STEM})\\.txt 2> \\1\\.err$`,
);
const PROMPT_FILE = new RegExp(`^${PROMPT_FILE_PATH}$`);
const COMMAND_START = String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:then|do|else)\b|\b(?:ba|z|da)?sh\s+(?:-\S+\s+)*-c\s+)`;
const COMMAND_WRAPPERS = String.raw`(?:(?:\S*/)?(?:xargs|time|sudo|nice|nohup|exec|command|env|timeout|stdbuf|eval|watch|npx|bunx|npm\s+(?:exec|x)|bun\s+x|pnpm\s+dlx|yarn\s+dlx)(?:\s+(?:-[A-Za-z]\s+[^-\s]\S*|-\S+|\S+=\S*|\d+\S*))*\s+)*`;
const EXTERNAL_CLI_INVOCATION = new RegExp(
  String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?(?:@openai/)?codex['"]?(?=\s|$|[;&|)@])`,
  "m",
);
const COMMAND_LOOKUP = /(?:^|[;&|]\s*)(?:command\s+-[vV]|type|which|hash)\s+codex\s*(?=$|[;&|])/;

function gateDispatcher(toolName, toolInput) {
  if (toolName === "Write") {
    if (PROMPT_FILE.test(String(toolInput.file_path || ""))) allow();
    denyPreToolUse(`codex-dispatcher may only write its prompt file, matching ${PROMPT_FILE_PATH}.`);
  }
  if (toolName !== "Bash") allow();
  if (SANCTIONED_DISPATCH_COMMAND.test(String(toolInput.command || "").trim())) allow();
  denyPreToolUse(
    "codex-dispatcher may only run the qa_review read-only dispatch command qa-swarm.js builds, " +
      "reading its prompt from /tmp/codex-dispatch-<name>.txt and writing stderr to /tmp/codex-dispatch-<name>.err. " +
      "Report this denial through the task's failure path; do not retry.",
  );
}

let isDispatcherCall = false;

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (!payload.agent_id) allow();
  isDispatcherCall = payload.agent_type === DISPATCHER_AGENT_TYPE;

  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (isDispatcherCall) gateDispatcher(payload.tool_name, toolInput);

  if (payload.tool_name !== "Bash") allow();
  const command = String(toolInput.command || "");
  if (!EXTERNAL_CLI_INVOCATION.test(command)) allow();
  if (COMMAND_LOOKUP.test(command) && !EXTERNAL_CLI_INVOCATION.test(command.replace(COMMAND_LOOKUP, ""))) allow();
  denyPreToolUse(
    "Subagents never offload to Codex (global AGENTS.md <scope>). " +
      "Do the assigned work with your own tools, or report back that it needs the main loop.",
  );
}

try {
  main();
} catch {
  if (isDispatcherCall) denyPreToolUse("codex-dispatch gate failed, so the relay is denied rather than left unconfined.");
  allow();
}
