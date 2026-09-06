import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function runHook(scriptName, payload, env = {}, cwd = process.cwd()) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, scriptName)], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

export function removeAll(...paths) {
  for (const target of paths) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function runGit(repository, argumentsList) {
  const processResult = spawnSync("git", argumentsList, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(processResult.status, 0, processResult.stderr);
  return (processResult.stdout ?? "").trim();
}

export function makeRepository(committedContent = "one\n", workingContent = "two\n") {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "finding-scope-hook-"));
  runGit(repository, ["init", "-q"]);
  runGit(repository, ["config", "user.name", "Test User"]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "a.txt"), committedContent, "utf8");
  runGit(repository, ["add", "--", "a.txt"]);
  runGit(repository, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repository, "a.txt"), workingContent, "utf8");
  return repository;
}
