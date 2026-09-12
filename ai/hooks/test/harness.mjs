import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitFile, makeRepo } from "../../skills/commit/test/helpers.ts";

export { cleanup as removeAll } from "../../skills/commit/test/helpers.ts";

export const HOOKS_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function runHook(scriptName, payload, env = {}, cwd = process.cwd()) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, scriptName)], {
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
