import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitFile, makeRepo } from "../../skills/landing/test/helpers.ts";

export { cleanup as removeAll } from "../../skills/landing/test/helpers.ts";

export const HOOKS_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function runHook(scriptName, payload, env = {}, cwd = process.cwd(), hookArguments = []) {
  return spawnSync("node", [path.resolve(HOOKS_DIRECTORY, scriptName), ...hookArguments], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

export function makeRepository(committedContent = "one\n", workingContent = "two\n") {
  const repository = makeRepo();
  commitFile(repository, "a.txt", committedContent);
  fs.writeFileSync(path.join(repository, "a.txt"), workingContent, "utf8");
  return repository;
}

export function codexRolloutLines(originator, ...userTexts) {
  const sessionMeta = { type: "session_meta", payload: { originator, source: originator === "codex_exec" ? "exec" : "cli" } };
  const userMessages = userTexts.map((text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
  return [sessionMeta, ...userMessages];
}

export function codexPatchCall(callId, patch) {
  return { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: callId, input: `text(await tools.apply_patch(${JSON.stringify(patch)}))` } };
}

export function agyStep(stepIndex, type, content, toolCalls = [], status = "DONE") {
  return { step_index: stepIndex, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status, content, tool_calls: toolCalls };
}
