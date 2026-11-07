#!/usr/bin/env node
import { allow, denyPreToolUse, readPayload, SPAWN_TOOLS } from "./hook-io.mjs";

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
  const denialReasons = [];
  if (missingMarkers.length > 0)
    denialReasons.push(
      `Subagent spawn prompt is missing required scope markers: ${missingMarkers.join(", ")}\n` +
        `Use this template:\n${SCOPE_TEMPLATE}`
    );

  const model =
    typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
  if (model === "")
    denialReasons.push(
      "Subagent spawn without an explicit model pin: omitting `model` " +
        "inherits the session model, so the tier becomes an accident " +
        "rather than a choice. " +
        PIN_HINT
    );

  if (denialReasons.length > 0) denyPreToolUse(denialReasons.join("\n\n"));
  allow();
}

try {
  main();
} catch {
  allow();
}
