#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { readPayload } from "./hook-io.mjs";

const MINIMUM_INCIDENTS_FOR_NUDGE = 3;
const MAXIMUM_SESSION_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAXIMUM_PRINTED_SESSIONS = 5;
const MAXIMUM_PRINTED_LENGTH = 120;

function repositoryKey(cwd) {
  const gitProbe = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const commonDirectory = gitProbe.stdout?.trim();
  if (gitProbe.error || gitProbe.status !== 0 || !commonDirectory || !isAbsolute(commonDirectory)) return cwd;
  return dirname(commonDirectory);
}

function inert(value) {
  const flattened = Array.from(String(value).slice(0, MAXIMUM_PRINTED_LENGTH * 4), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) return " ";
    if (character === "`") return "'";
    return character;
  }).join("").replace(/\s+/g, " ").trim();
  if (flattened.length > MAXIMUM_PRINTED_LENGTH) return `${flattened.slice(0, MAXIMUM_PRINTED_LENGTH)}...`;
  return flattened;
}

function ageSince(at, nowMs) {
  const elapsedHours = Math.max(0, Math.floor((nowMs - Date.parse(at)) / (60 * 60 * 1000)));
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

async function remind(payload) {
  if (!payload || typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) return;
  if (typeof payload.session_id !== "string" || !payload.session_id.trim()) return;
  if (!["SessionStart", "SessionEnd"].includes(payload.hook_event_name)) return;
  const { readRetroLedger, recordSession, unreviewedSessions } = await import("../skills/running-retros/lib/ledger.ts");
  const ledger = readRetroLedger();
  const repo = repositoryKey(payload.cwd);
  const nowMs = Date.now();

  if (payload.hook_event_name === "SessionStart") {
    const sessions = unreviewedSessions(ledger, MINIMUM_INCIDENTS_FOR_NUDGE)
      .filter((entry) => entry.repo === repo && entry.sessionId !== payload.session_id
        && nowMs - Date.parse(entry.at) < MAXIMUM_SESSION_AGE_MS)
      .slice(0, MAXIMUM_PRINTED_SESSIONS);
    if (sessions.length === 0) return;
    const lines = ["Unreviewed rough sessions in this repo (run /running-retros <id> to review, or ignore):"];
    for (const entry of sessions) {
      lines.push(`\`${inert(entry.sessionId)}\`  ${inert(entry.incidentCount)} incidents  ${inert(ageSince(entry.at, nowMs))}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (ledger.sessions.some((entry) => entry.sessionId === payload.session_id && entry.reviewed)) return;
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path.trim()) return;
  const { digestTranscript } = await import("../skills/running-retros/lib/digest.ts");
  const digest = await digestTranscript(payload.transcript_path, { includeGit: false });
  const incidentCount = digest.incidents.length;
  const wasRecorded = recordSession({
    v: 1,
    kind: "session",
    at: new Date(nowMs).toISOString(),
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    repo,
    incidentCount,
    counts: digest.counts,
    reviewed: false,
  });
  if (!wasRecorded || incidentCount < MINIMUM_INCIDENTS_FOR_NUDGE) return;
  const topKinds = Object.entries(digest.counts)
    .filter(([, count]) => count > 0)
    .sort((first, second) => second[1] - first[1])
    .slice(0, 2)
    .map(([kind, count]) => `${inert(kind)} ${inert(count)}`)
    .join(", ");
  process.stderr.write(`retro: ${incidentCount} incidents this session (${topKinds}). Review with /running-retros ${inert(payload.session_id)}\n`);
}

try {
  await remind(readPayload());
} catch {
  process.exit(0);
}
