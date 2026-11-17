#!/usr/bin/env node
import fs from "node:fs";
import { allow, readPayload } from "./hook-io.mjs";
import { isSkillRun, sessionEvents } from "./session-transcript.mjs";

const LANE_AGENT_TYPES = new Set(["qa-code-reviewer", "security-reviewer", "redteam-reviewer", "boundary-reviewer", "architecture-reviewer"]);
const ENGINE_WORKFLOW_NAME = "qa-swarm";

function isEngineLaunch(event) {
  if (event.kind !== "toolUse") return false;
  if (event.name === "Workflow") return event.input.name === ENGINE_WORKFLOW_NAME;
  return spawnsLaneAgent(event);
}

function spawnsLaneAgent(event) {
  return (event.name === "Agent" || event.name === "Task") && LANE_AGENT_TYPES.has(String(event.input.subagent_type));
}

async function hasEngineRunSinceLastReview(transcriptPath) {
  let hasEngineRun = true;
  const pendingLaunchIds = new Set();
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, "reviewing-prs")) hasEngineRun = false;
    if (isEngineLaunch(event)) pendingLaunchIds.add(event.id);
    const isLaunchResult = event.kind === "toolResult" && pendingLaunchIds.delete(event.toolUseId);
    if (isLaunchResult && !event.isError) hasEngineRun = true;
  }
  return hasEngineRun;
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || payload.stop_hook_active === true) allow();
  if (typeof payload.transcript_path !== "string" || !fs.existsSync(payload.transcript_path)) allow();
  if (await hasEngineRunSinceLastReview(payload.transcript_path)) allow();
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason:
      "reviewing-prs: the review engine has not run. Invoke /reviewing-code with the base and head SHAs now; it launches Workflow qa-swarm. " +
      "No diff is too small or docs-only to skip it. If Step 1 found no pull request, say so in one line and stop.",
  }));
  process.exit(0);
}

try {
  await main();
} catch {
  allow();
}
