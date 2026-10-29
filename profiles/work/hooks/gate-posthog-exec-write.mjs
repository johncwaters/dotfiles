#!/usr/bin/env node
import { allow, askPreToolUse, readPayload } from "../../../ai/hooks/hook-io.mjs";

const POSTHOG_EXEC_TOOL = /^mcp__.*__exec$/;
const CALLED_POSTHOG_TOOL = /^\s*call\s+(?:--json\s+)?([A-Za-z0-9_-]+)/;
const WRITE_VERB =
  /(?:^|-)(?:archive|cancel|create|delete|destroy|disable|duplicate|enable|end|invocations|launch|materialize|merge|move|partial-update|pause|rearrange|reload|rename|reorder|reset|restore|resume|resync|retry|set|ship|unarchive|unmaterialize|update)(?:-|$)/i;
const SENSITIVE_WRITE =
  /feature-flag|delete|destroy|^(?:experiment-launch|experiment-ship-variant|experiment-reset|survey-launch|workflows-enable|conversations-tickets-compose-create|conversations-tickets-reply-create)$/i;

function sensitivePosthogWrite(payload) {
  if (!POSTHOG_EXEC_TOOL.test(String(payload.tool_name || ""))) return "";
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const calledTool = CALLED_POSTHOG_TOOL.exec(String(toolInput.command || ""))?.[1] || "";
  if (!WRITE_VERB.test(calledTool)) return "";
  if (!SENSITIVE_WRITE.test(calledTool)) return "";
  return calledTool;
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const calledTool = sensitivePosthogWrite(payload);
  if (!calledTool) allow();
  askPreToolUse(`\`${calledTool}\` modifies PostHog data, approve to run.`);
} catch {
  allow();
}
