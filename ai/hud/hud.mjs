#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Fail open because a malformed Claude Code payload must not break the statusline.

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const ORANGE = "\x1b[38;5;172m";

function limitColor(pct) {
  if (pct >= 90) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function contextStyle(pct) {
  if (pct >= 85) return { color: RED, suffix: " CRITICAL" };
  if (pct >= 80) return { color: YELLOW, suffix: " COMPRESS?" };
  if (pct >= 70) return { color: YELLOW, suffix: "" };
  return { color: GREEN, suffix: "" };
}

function clampPct(pct) {
  return Math.min(100, Math.max(0, Math.round(pct)));
}

function parseResetsAt(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    // epoch seconds vs milliseconds
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// OMC duration format: 2d5h above a day, else 3h42m.
function fmtReset(date) {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return null;
  const totalMin = Math.floor(diffMs / 60000);
  const totalH = Math.floor(totalMin / 60);
  const days = Math.floor(totalH / 24);
  if (days > 0) return `${days}d${totalH % 24}h`;
  return `${totalH}h${totalMin % 60}m`;
}

function limitPart(label, limit) {
  if (!limit || typeof limit.used_percentage !== "number") return null;
  const pct = clampPct(limit.used_percentage);
  let part = `${DIM}${label}:${RESET}${limitColor(pct)}${pct}%${RESET}`;
  const resetDate = parseResetsAt(limit.resets_at);
  const reset = resetDate ? fmtReset(resetDate) : null;
  if (reset) part += ` ${DIM}(${reset})${RESET}`;
  return part;
}

function fmtTokens(n) {
  if (typeof n !== "number") return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// https://platform.claude.com/docs/en/about-claude/pricing (Opus 5.5 cache hit), checked 2026-10-10.
const OPUS_5_5_CACHE_READ_USD_PER_MILLION = 0.2;

function contextTokensInUse(contextWindow) {
  const usage = contextWindow.current_usage;
  if (usage) {
    return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  }
  if (typeof contextWindow.used_percentage !== "number" || typeof contextWindow.context_window_size !== "number") return null;
  return Math.round((contextWindow.used_percentage / 100) * contextWindow.context_window_size);
}

function configuredAutoCompactWindow() {
  const fromEnvironment = Number.parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "", 10);
  if (fromEnvironment > 0) return fromEnvironment;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return typeof settings.autoCompactWindow === "number" ? settings.autoCompactWindow : null;
  } catch {
    return null;
  }
}

function autoCompactWindow(contextWindowSize) {
  const configuredWindow = configuredAutoCompactWindow();
  if (!configuredWindow) return contextWindowSize;
  if (typeof contextWindowSize !== "number") return configuredWindow;
  return Math.min(configuredWindow, contextWindowSize);
}

function contextTokensLabel(tokensInUse, compactWindow) {
  if (!compactWindow) return fmtTokens(tokensInUse);
  const { color, suffix } = contextStyle(clampPct((tokensInUse / compactWindow) * 100));
  return `${color}${fmtTokens(tokensInUse)}/${fmtTokens(compactWindow)}${suffix}${RESET}`;
}

function contextPart(payload) {
  const contextWindow = payload.context_window || {};
  const tokensInUse = contextTokensInUse(contextWindow);
  if (tokensInUse === null) return null;
  const compactWindow = autoCompactWindow(contextWindow.context_window_size);
  const segment = `${DIM}ctx:${RESET}${contextTokensLabel(tokensInUse, compactWindow)}`;
  const isOpus55 = ((payload.model && payload.model.id) || "").startsWith("claude-opus-5-5");
  if (!isOpus55) return segment;
  const cacheReadUsdPerCall = (tokensInUse / 1e6) * OPUS_5_5_CACHE_READ_USD_PER_MILLION;
  return `${segment} ${DIM}~$${cacheReadUsdPerCall.toFixed(2)}/call${RESET}`;
}

const CAVEMAN_BADGE_BY_MODE = {
  caveman: "CAVEMAN", lite: "CAVEMAN", full: "CAVEMAN",
  ultracave: "ULTRACAVE", ultra: "ULTRACAVE",
  megacave: "MEGACAVE", wenyan: "MEGACAVE", "wenyan-lite": "MEGACAVE", "wenyan-full": "MEGACAVE", "wenyan-ultra": "MEGACAVE",
  commit: "CAVEMAN:COMMIT", review: "CAVEMAN:REVIEW", compress: "CAVEMAN:COMPRESS",
};

function cavemanPart() {
  try {
    const mode = readFileSync(join(homedir(), ".claude", ".caveman-active"), "utf8").trim();
    if (!Object.hasOwn(CAVEMAN_BADGE_BY_MODE, mode)) return null;
    return `${ORANGE}[${CAVEMAN_BADGE_BY_MODE[mode]}]${RESET}`;
  } catch {
    return null;
  }
}

function render(payload) {
  const parts = [];

  const model = payload.model || {};
  const name = model.display_name || model.id;
  if (name) {
    let seg = `${CYAN}Model: ${name}${RESET}`;
    const effort = payload.effort && payload.effort.level;
    if (effort) seg += ` ${DIM}(${effort})${RESET}`;
    parts.push(seg);
  }

  const rl = payload.rate_limits || {};
  const limits = [limitPart("5h", rl.five_hour), limitPart("wk", rl.seven_day)].filter(Boolean);
  if (limits.length > 0) parts.push(limits.join(" "));

  const contextSegment = contextPart(payload);
  if (contextSegment) parts.push(contextSegment);

  const sessionCostUsd = payload.cost && payload.cost.total_cost_usd;
  if (typeof sessionCostUsd === "number") parts.push(`${DIM}session:${RESET}$${sessionCostUsd.toFixed(2)}`);

  const caveman = cavemanPart();
  if (caveman) parts.push(caveman);

  return parts.join(`${DIM} | ${RESET}`);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    process.stdout.write(render(JSON.parse(input)));
  } catch {
    process.stdout.write("");
  }
});
