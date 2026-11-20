#!/usr/bin/env node
import fs from "node:fs";
import { allow, blockStop, readPayload } from "./hook-io.mjs";
import { finalReply, sessionEvents } from "./session-transcript.mjs";

const PERSON_WORDS = /\b(?:humans?|persons?|people|developers?|engineers?|users?)\b(?![-_/.]\w)/gi;
const QUOTED_OR_CODE_SPANS = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]*`/g,
  /^\s*>.*$/gm,
  /"[^"\n]*"/g,
  /“[^”\n]*”/g,
  /\bhttps?:\/\/\S+/g,
];

function proseOutsideCodeAndQuotes(message) {
  return QUOTED_OR_CODE_SPANS.reduce((remainingText, span) => remainingText.replace(span, " "), message);
}

const OWN_FEEDBACK_MARKER = "where <output_style> requires";

function hasTranscript(payload) {
  return typeof payload.transcript_path === "string" && fs.existsSync(payload.transcript_path);
}

async function hasBlockedThisTurn(payload) {
  if (payload.agent !== "claude" || !hasTranscript(payload)) return payload.stop_hook_active === true;
  let hasBlocked = false;
  for await (const event of sessionEvents(payload.transcript_path)) {
    if (event.kind === "prompt") hasBlocked = false;
    if (event.kind === "stopFeedback" && event.text.includes(OWN_FEEDBACK_MARKER)) hasBlocked = true;
  }
  return hasBlocked;
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || payload.agent_id) allow();
  const replyText = typeof payload.last_assistant_message === "string" || !hasTranscript(payload)
    ? payload.last_assistant_message
    : await finalReply(payload.transcript_path, payload.agent);
  if (typeof replyText !== "string") allow();
  if (await hasBlockedThisTurn(payload)) allow();
  const personWordsUsed = [...new Set(proseOutsideCodeAndQuotes(replyText).match(PERSON_WORDS) ?? [])];
  if (personWordsUsed.length === 0) allow();
  blockStop(
    `The reply says ${personWordsUsed.map((word) => `"${word}"`).join(", ")} where <output_style> requires "carbon unit" or "carbon units". ` +
    "Resend the reply with that wording; code, identifiers, verbatim quotes, and user-level terms stay as they are.",
  );
}

try {
  await main();
} catch {
  allow();
}
