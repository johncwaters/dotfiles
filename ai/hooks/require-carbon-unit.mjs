#!/usr/bin/env node
import fs from "node:fs";
import { allow, readPayload } from "./hook-io.mjs";
import { sessionEvents } from "./session-transcript.mjs";

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

async function hasBlockedThisTurn(payload) {
  if (typeof payload.transcript_path !== "string" || !fs.existsSync(payload.transcript_path)) return payload.stop_hook_active === true;
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
  if (typeof payload.last_assistant_message !== "string") allow();
  if (await hasBlockedThisTurn(payload)) allow();
  const personWordsUsed = [...new Set(proseOutsideCodeAndQuotes(payload.last_assistant_message).match(PERSON_WORDS) ?? [])];
  if (personWordsUsed.length === 0) allow();
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason:
      `The reply says ${personWordsUsed.map((word) => `"${word}"`).join(", ")} where <output_style> requires "carbon unit" or "carbon units". ` +
      "Resend the reply with that wording; code, identifiers, verbatim quotes, and user-level terms stay as they are.",
  }));
  process.exit(0);
}

try {
  await main();
} catch {
  allow();
}
