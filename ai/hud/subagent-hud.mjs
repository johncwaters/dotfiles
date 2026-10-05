#!/usr/bin/env node

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const SEPARATOR = " · ";

function shortModelName(modelId) {
  if (typeof modelId !== "string") return null;
  return modelId.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, "");
}

function startTimeInMs(startTime) {
  if (typeof startTime === "number") return startTime > 1e12 ? startTime : startTime * 1000;
  if (typeof startTime !== "string") return null;
  const parsedMs = Date.parse(startTime);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatTokens(tokenCount) {
  if (tokenCount < 1000) return String(tokenCount);
  if (tokenCount < 1000000) return `${(tokenCount / 1000).toFixed(1)}k`;
  return `${(tokenCount / 1000000).toFixed(2)}M`;
}

function contextColor(usedPercentage) {
  if (usedPercentage >= 85) return RED;
  if (usedPercentage >= 70) return YELLOW;
  return GREEN;
}

function contextSegment(task) {
  if (typeof task.tokenCount !== "number") return null;
  const tokens = formatTokens(task.tokenCount);
  if (typeof task.contextWindowSize !== "number" || task.contextWindowSize <= 0) return `ctx ${tokens}`;
  const usedPercentage = Math.round((task.tokenCount / task.contextWindowSize) * 100);
  return `ctx ${tokens} ${contextColor(usedPercentage)}${usedPercentage}%${RESET}${DIM}`;
}

function effortSegment(effort) {
  if (typeof effort === "string") return effort;
  if (typeof effort === "number") return `${formatTokens(effort)} think`;
  return null;
}

function renderRow(task, nowMs) {
  const startedAtMs = startTimeInMs(task.startTime);
  const details = [
    shortModelName(task.model),
    effortSegment(task.effort),
    startedAtMs === null ? null : formatElapsed(nowMs - startedAtMs),
    contextSegment(task),
  ].filter((segment) => typeof segment === "string" && segment !== "");
  const heading = task.name || task.description || task.id;
  return `${BOLD}${heading}${RESET}  ${DIM}${details.join(SEPARATOR)}${RESET}`;
}

function isRenderableTask(task) {
  return typeof task === "object" && task !== null && typeof task.id === "string";
}

function renderRows(payload, nowMs) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return tasks
    .filter(isRenderableTask)
    .map((task) => JSON.stringify({ id: task.id, content: renderRow(task, nowMs) }))
    .join("\n");
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    process.stdout.write(renderRows(JSON.parse(input), Date.now()));
  } catch (error) {
    process.stderr.write(`subagent-hud: ${error.message}\n`);
  }
});
