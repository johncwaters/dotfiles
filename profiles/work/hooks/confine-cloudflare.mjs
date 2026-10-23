#!/usr/bin/env node
import { allow, denyPreToolUse, readPayload } from "../../../ai/hooks/hook-io.mjs";
import { isWorkRepository } from "./work-repository.mjs";

const CLOUDFLARE_MCP_TOOL = /^mcp__.*cloudflare/i;
const CLOUDFLARE_SKILL = /^cloudflare:/i;
const DISTINCTIVE_CLOUDFLARE_REFERENCE = /\b(?:wrangler|flarectl|cloudflared)\b|api\.cloudflare\.com/i;
const COMMAND_START = String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:if|then|do|else)\b|\b(?:ba|z|da)?sh\s+(?:-\S+\s+)*-c\s+)`;
const ENVIRONMENT_ASSIGNMENTS = String.raw`(?:\S+=\S*\s+)*`;
const COMMAND_WRAPPERS = String.raw`(?:(?:\S*/)?(?:xargs|time|sudo|nice|nohup|exec|command|env|timeout|stdbuf|eval|watch|npx|bunx|npm\s+(?:exec|x)|bun(?:\s+x)?|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+(?:dlx|workspace\s+\S+))?)(?:\s+(?:-[A-Za-z]\s+[^-\s]\S*|--\S+\s+[^-\s]\S*|-\S+|\S+=\S*|\d+\S*))*\s+)*`;
const SHELL_QUOTING_CHARACTERS = /['"\\]/g;
const CF_CLI_INVOCATION = new RegExp(
  String.raw`${COMMAND_START}\s*${ENVIRONMENT_ASSIGNMENTS}${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?cf['"]?(?=\s|$|[;&|)@])`,
  "m",
);

function touchesCloudflare(toolName, toolInput) {
  if (CLOUDFLARE_MCP_TOOL.test(toolName)) return true;
  if (toolName === "Skill") return CLOUDFLARE_SKILL.test(String(toolInput.skill || ""));
  if (toolName !== "Bash") return false;
  const command = String(toolInput.command || "");
  const commandWithoutQuoting = command.replace(SHELL_QUOTING_CHARACTERS, "");
  return (
    DISTINCTIVE_CLOUDFLARE_REFERENCE.test(command) ||
    CF_CLI_INVOCATION.test(command) ||
    CF_CLI_INVOCATION.test(commandWithoutQuoting)
  );
}

let isCloudflareCall = false;

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const toolName = String(payload.tool_name || "");
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  isCloudflareCall = touchesCloudflare(toolName, toolInput);
  if (!isCloudflareCall) allow();
  const sessionDirectory = String(payload.cwd || process.cwd());
  if (isWorkRepository(sessionDirectory)) allow();
  denyPreToolUse(
    "Cloudflare work is confined to PostHog work repositories and the backchannel clone at ~/Projects/backchannel. " +
      "This session is not in one, so Cloudflare tools, skills, and CLIs are denied. Do not retry or work around it.",
  );
}

try {
  main();
} catch {
  if (!isCloudflareCall) allow();
  denyPreToolUse("Cloudflare confinement check failed, so the call is denied rather than left unconfined.");
}
