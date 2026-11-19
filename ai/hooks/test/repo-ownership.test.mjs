import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { removeAll } from "./harness.mjs";
import { describeSessionOwnership, isPathOwned, readOwnedEntries } from "../repo-ownership.mjs";

const createdDirectories = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) removeAll(directory);
});

function makeCloneOf(remoteUrl) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "repo-ownership-"));
  createdDirectories.push(repository);
  spawnSync("git", ["init", "-q", repository]);
  if (remoteUrl) spawnSync("git", ["-C", repository, "remote", "add", "origin", remoteUrl]);
  return repository;
}

function entriesFrom(listText) {
  const listDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-ownership-list-"));
  createdDirectories.push(listDirectory);
  const listPath = path.join(listDirectory, "owned-repos.txt");
  fs.writeFileSync(listPath, listText);
  return readOwnedEntries(listPath);
}

const workEntries = entriesFrom(fs.readFileSync(new URL("../../../profiles/work/owned-repos.txt", import.meta.url), "utf8"));

test("the work list owns knowledge_writer inside posthog and nothing else there", () => {
  const posthog = makeCloneOf("git@github.com:PostHog/posthog.git");
  assert.equal(isPathOwned(path.join(posthog, "products/knowledge_writer/backend/new.py"), workEntries), true);
  assert.equal(isPathOwned(path.join(posthog, "products/knowledge_writer"), workEntries), true);
  assert.equal(isPathOwned(path.join(posthog, "products/commands/backend/views.py"), workEntries), false);
  assert.deepEqual(describeSessionOwnership(posthog, workEntries), { ownership: "foreign", ownedPaths: ["products/knowledge_writer/**"] });
});

test("whole-repo entries own every path while unlisted, remoteless and non-git paths stay foreign", () => {
  const wizard = makeCloneOf("https://github.com/PostHog/wizard.git");
  const personal = makeCloneOf("git@github.com:johncwaters/dotfiles.git");
  const otherTeam = makeCloneOf("https://github.com/PostHog/posthog-js.git");
  const remoteless = makeCloneOf(null);
  assert.equal(isPathOwned(path.join(wizard, "src/index.ts"), workEntries), true);
  assert.equal(describeSessionOwnership(personal, workEntries).ownership, "owned");
  assert.equal(isPathOwned(path.join(otherTeam, "src/index.ts"), workEntries), false);
  assert.equal(isPathOwned(path.join(remoteless, "a.ts"), workEntries), false);
  assert.equal(isPathOwned(path.join(os.tmpdir(), "no-such-dir", "a.ts"), workEntries), false);
  assert.equal(isPathOwned(path.join(wizard, "a.ts"), entriesFrom("")), false);
});
