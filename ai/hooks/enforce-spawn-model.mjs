#!/usr/bin/env node
/**
 * PreToolUse guard for subagent spawns (Agent / Task tool calls).
 *
 * Enforces the CLAUDE.md routing rules that every spawn pins `model` and
 * carries explicit scope boundaries and a definition of done.
 *
 * Denies when:
 *   - `model` is missing or empty (would inherit the session model)
 *   - `prompt` omits a required scope marker
 *
 * fable is a permitted spawn target: the routing table lists it as a
 * normal tier, so only the missing-pin case is a violation now.
 *
 * Allows everything else, including subagent_type "fork": the harness
 * ignores `model` for forks, so a deny would be unactionable there.
 *
 * Fail open (shared rule in AGENTS.md): any error, malformed payload, or
 * unexpected shape MUST result in allow (exit 0, no output). Every
 * try/catch that falls through to allow is load-bearing.
 *
 * Keep it dependency-free, synchronous, and pure ASCII.
 */

import { allow, readPayload, SPAWN_TOOLS } from "./hook-io.mjs";

const REQUIRED_PROMPT_MARKERS = [
  { label: "Scope:", pattern: /^\s*(?:#{1,6}\s*)?scope:/im },
  { label: "Out of scope:", pattern: /^\s*(?:#{1,6}\s*)?out of scope:/im },
  {
    label: "Definition of done:",
    pattern: /^\s*(?:#{1,6}\s*)?definition of done:/im,
  },
];

const SCOPE_TEMPLATE = "Scope:\nOut of scope:\nDefinition of done:";

const PIN_HINT =
  'Re-issue the call with an explicit model: "opus" (default coding tier), ' +
  '"fable" (top tier, for the highest-stakes judgment), "sonnet" (one-shot ' +
  'mechanical slices), or "haiku" (one-shot basics whose whole output is a ' +
  'short checkable answer).';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (!SPAWN_TOOLS.has(payload.tool_name)) allow();

  const input = payload.tool_input;
  if (!input || typeof input !== "object") allow();

  if (input.subagent_type === "fork") allow();

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const missingMarkers = REQUIRED_PROMPT_MARKERS.filter(
    ({ pattern }) => !pattern.test(prompt)
  ).map(({ label }) => label);
  if (missingMarkers.length > 0)
    deny(
      `Subagent spawn prompt is missing required scope markers: ${missingMarkers.join(", ")}\n` +
        `Use this template:\n${SCOPE_TEMPLATE}`
    );

  const model =
    typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
  if (model === "")
    deny(
      "Subagent spawn without an explicit model pin: omitting `model` " +
        "inherits the session model, so the tier becomes an accident " +
        "rather than a choice. " +
        PIN_HINT
    );

  allow();
}

try {
  main();
} catch {
  allow();
}
