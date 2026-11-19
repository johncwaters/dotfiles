import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { HOOKS_DIRECTORY, removeAll } from "./harness.mjs";

const createdDirectories = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) removeAll(directory);
});

function makeCloneOf(remoteUrl) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-"));
  createdDirectories.push(repository);
  spawnSync("git", ["init", "-q", repository]);
  spawnSync("git", ["-C", repository, "remote", "add", "origin", remoteUrl]);
  return repository;
}

function commitFile(repository, relativePath, content) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  spawnSync("git", ["-C", repository, "add", relativePath]);
}

function runRatchet(commandName, root, ownedListPath) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, "ratchet.mjs"), commandName, root], {
    encoding: "utf8",
    env: { ...process.env, DOTFILES_OWNED_REPOS_FILE: ownedListPath },
  });
}

function readBaselineCounts(root) {
  const { scanner, ...counts } = JSON.parse(fs.readFileSync(path.join(root, ".agents/ratchet.json"), "utf8"));
  return counts;
}

test("owned sub-project baseline fails on growth, lowers on a fall, and a foreign root gets none", () => {
  const listDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-list-"));
  createdDirectories.push(listDirectory);
  const ownedListPath = path.join(listDirectory, "owned-repos.txt");
  fs.writeFileSync(ownedListPath, "github.com/team/mono:apps/mine/**\n");
  const monorepo = makeCloneOf("git@github.com:team/mono.git");
  const ownedRoot = path.join(monorepo, "apps/mine");
  const elseBranch = ["if (x) { a(); }", "e" + "lse { b(); }"].join(" ");
  commitFile(monorepo, "apps/mine/a.ts", `// one\n// two\n${elseBranch}\n`);
  commitFile(monorepo, "apps/other/b.ts", "// outside the owned root\n");

  assert.equal(runRatchet("init", path.join(monorepo, "apps/other"), ownedListPath).status, 1);
  assert.equal(fs.existsSync(path.join(monorepo, "apps/other/.agents/ratchet.json")), false);
  assert.equal(runRatchet("init", ownedRoot, ownedListPath).status, 0);
  assert.deepEqual(readBaselineCounts(ownedRoot), { comments: 2, elseStatements: 1, useEffect: 0 });
  spawnSync("git", ["-C", monorepo, "add", "apps/mine/.agents/ratchet.json"]);

  commitFile(monorepo, "apps/mine/a.ts", `// one\n// two\n// three\n${elseBranch}\n`);
  const grownRun = runRatchet("check", monorepo, ownedListPath);
  assert.equal(grownRun.status, 1);
  assert.match(grownRun.stderr, /comments grew from 2 to 3\. Fix: delete the comment/);

  commitFile(monorepo, "apps/mine/a.ts", "// one\nif (!x) { b(); return; }\na();\n");
  assert.equal(runRatchet("check", monorepo, ownedListPath).status, 0);
  assert.deepEqual(readBaselineCounts(ownedRoot), { comments: 1, elseStatements: 0, useEffect: 0 });
});

test("an unstaged new file counts toward growth and a baseline raised above HEAD fails", () => {
  const repository = makeCloneOf("git@github.com:me/app.git");
  commitFile(repository, "a.ts", "// one\n");
  assert.equal(runRatchet("init", repository, "/dev/null").status, 1);
  const listPath = path.join(repository, ".git", "owned-repos.txt");
  fs.writeFileSync(listPath, "github.com/me/*\n");
  assert.equal(runRatchet("init", repository, listPath).status, 0);
  spawnSync("git", ["-C", repository, "add", "-A"]);
  spawnSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "baseline"]);

  fs.writeFileSync(path.join(repository, "b.ts"), "// unstaged\n");
  assert.match(runRatchet("check", repository, listPath).stderr, /comments grew from 1 to 2/);

  const baselinePath = path.join(repository, ".agents/ratchet.json");
  const raisedBaseline = { ...JSON.parse(fs.readFileSync(baselinePath, "utf8")), comments: 5 };
  fs.writeFileSync(baselinePath, JSON.stringify(raisedBaseline));
  assert.match(runRatchet("check", repository, listPath).stderr, /comments baseline was raised above its committed value/);
});
