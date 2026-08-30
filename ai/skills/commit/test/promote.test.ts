import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findWorktreeForBranch } from "../lib/workspace.ts";
import {
  cleanup,
  cloneRepo,
  commitFile,
  gitOutput,
  land,
  makeBareOrigin,
  makePolicyRoot,
  makeRepo,
  runGit,
  runSkillScript,
  tryGit,
  VALID_MESSAGE,
  writeFile,
} from "./helpers.ts";

type PromotionSetup = { origin: string; seed: string; local: string };

function seedOrigin(featureBranch = "feature"): PromotionSetup {
  const origin = makeBareOrigin();
  const seed = makeRepo();
  runGit(seed, ["remote", "add", "origin", origin]);
  commitFile(seed, "base.txt", "base\n", "init");
  runGit(seed, ["push", "-q", "-u", "origin", "main"]);
  runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(seed, ["checkout", "-q", "-b", featureBranch]);
  runGit(seed, ["push", "-q", "-u", "origin", featureBranch]);
  const local = cloneRepo(origin);
  runGit(local, ["checkout", "-q", "-b", featureBranch, `origin/${featureBranch}`]);
  return { origin, seed, local };
}

function writeOriginHook(origin: string, name: string, body: string): void {
  const hookPath = path.join(origin, "hooks", name);
  fs.writeFileSync(hookPath, body, "utf8");
  fs.chmodSync(hookPath, 0o755);
}

function rejectUpdateHook(branch: string): string {
  return [
    "#!/bin/sh",
    'ref_name="$1"',
    `if [ "$ref_name" != "refs/heads/${branch}" ]; then`,
    "  exit 0",
    "fi",
    `echo "rejecting ${branch}" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

function rejectDeleteHook(branch: string): string {
  return [
    "#!/bin/sh",
    'ref_name="$1"',
    'new_sha="$3"',
    `if [ "$ref_name" != "refs/heads/${branch}" ]; then`,
    "  exit 0",
    "fi",
    'if [ "$new_sha" != "0000000000000000000000000000000000000000" ]; then',
    "  exit 0",
    "fi",
    `echo "rejecting deletion of ${branch}" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

test("findWorktreeForBranch skips detached and bare blocks", () => {
  const porcelain = [
    "worktree /repo/main",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/detached",
    "HEAD def456",
    "detached",
    "",
    "worktree /repo/bare",
    "bare",
    "",
  ].join("\n");
  assert.equal(findWorktreeForBranch(porcelain, "main"), "/repo/main");
  assert.equal(findWorktreeForBranch(porcelain, "feature"), null);
});

test("promotion rebases a feature branch onto main and pushes one mainline ref", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    const remoteFeatureBefore = gitOutput(origin, ["rev-parse", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(result.pushed, false);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), remoteFeatureBefore);
    assert.equal(gitOutput(local, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a pre-existing develop branch is ignored and untouched", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    runGit(seed, ["branch", "develop"]);
    runGit(seed, ["push", "-q", "origin", "develop"]);
    runGit(local, ["fetch", "-q", "origin", "develop:develop"]);
    const localDevelopBefore = gitOutput(local, ["rev-parse", "develop"]);
    const remoteDevelopBefore = gitOutput(origin, ["rev-parse", "develop"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(gitOutput(local, ["rev-parse", "develop"]), localDevelopBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "develop"]), remoteDevelopBefore);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("promotion does not create an absent intermediate branch", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.notEqual(tryGit(local, ["rev-parse", "-q", "--verify", "refs/heads/develop"]), 0);
    assert.notEqual(tryGit(origin, ["rev-parse", "-q", "--verify", "refs/heads/develop"]), 0);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a commit on mainline warns and skips promotion", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    const originBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nmain change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, []);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originBefore);
    assert.match((result.warnings as string[]).join("\n"), /landed directly on main/);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("no mainline commits and pushes the feature branch with a warning", () => {
  const origin = makeBareOrigin();
  const repo = makeRepo();
  try {
    commitFile(repo, "base.txt", "base\n", "init");
    runGit(repo, ["branch", "-m", "feature"]);
    runGit(repo, ["remote", "add", "origin", origin]);
    runGit(repo, ["push", "-q", "-u", "origin", "feature"]);
    writeFile(repo, "base.txt", "base\nfeature change\n");
    const { result } = land(repo, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, true);
    assert.deepEqual(result.promoted, []);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), result.commit);
    assert.match((result.warnings as string[]).join("\n"), /promotion skipped: no mainline/);
  } finally {
    cleanup(origin, repo);
  }
});

test("a master-only repository promotes directly to master", () => {
  const repo = makeRepo();
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    commitFile(repo, "base.txt", "base\n");
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    writeFile(repo, "base.txt", "base\nfeature change\n");
    const { result } = land(repo, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["master"]);
    assert.equal(gitOutput(repo, ["rev-parse", "master"]), result.commit);
  } finally {
    cleanup(repo);
  }
});

test("promotion honors a literal policy mainline", () => {
  const { origin, seed, local } = seedOrigin();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "trunk",
    afterCommit: "promote",
  });
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    runGit(seed, ["branch", "trunk"]);
    runGit(seed, ["push", "-q", "origin", "trunk"]);
    runGit(local, ["fetch", "-q", "origin", "trunk:trunk"]);
    const mainBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = runSkillScript(
      "land.ts",
      local,
      ["--push-retry-delay-ms", "0", "--promote"],
      VALID_MESSAGE,
      { CLAUDE_COMMIT_POLICY_ROOT: policyRoot },
    );

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["trunk"]);
    assert.equal(gitOutput(origin, ["rev-parse", "trunk"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainBefore);
  } finally {
    cleanup(origin, seed, local, policyRoot);
  }
});

test("a repository without origin promotes locally and warns", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "base.txt", "base\n");
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    writeFile(repo, "base.txt", "base\nfeature change\n");
    const { result } = land(repo, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(result.pushed, false);
    assert.equal(gitOutput(repo, ["rev-parse", "main"]), result.commit);
    assert.match((result.warnings as string[]).join("\n"), /updated locally only/);
  } finally {
    cleanup(repo);
  }
});

test("a behind mainline is fast-forwarded from origin before the feature rebase", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "remote.txt", "remote advance\n", "remote advance");
    runGit(seed, ["push", "-q", "origin", "main"]);
    const remoteAdvance = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(gitOutput(local, ["rev-parse", "main^"]), remoteAdvance);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("an ahead mainline returns MAINLINE_AHEAD with local-only commits and changes no refs", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    const localOnlyCommit = gitOutput(local, ["rev-parse", "main"]);
    runGit(local, ["checkout", "-q", "feature"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    const originFeatureBefore = gitOutput(origin, ["rev-parse", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "MAINLINE_AHEAD");
    assert.equal(code, 26);
    assert.equal(result.mainline, "main");
    assert.deepEqual(result.localOnlyCommits, [localOnlyCommit]);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), localOnlyCommit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), originFeatureBefore);
    assert.equal(gitOutput(local, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a diverged mainline returns PROMOTE_CONFLICT and changes no promotion refs", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    const localMainBefore = gitOutput(local, ["rev-parse", "main"]);
    runGit(local, ["checkout", "-q", "feature"]);
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "remote-only.txt", "remote only\n", "remote only");
    runGit(seed, ["push", "-q", "origin", "main"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    const originFeatureBefore = gitOutput(origin, ["rev-parse", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_CONFLICT");
    assert.equal(code, 23);
    assert.deepEqual(result.conflicts, []);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), localMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), originFeatureBefore);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a rejected mainline push is PROMOTE_FAILED and pushes the feature branch", () => {
  const featureBranch = "glissa/session/promotion-fallback";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeOriginHook(origin, "update", rejectUpdateHook("main"));
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.equal(code, 24);
    assert.equal(result.pushed, true);
    assert.deepEqual(result.promoted, []);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), result.commit);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), result.commit);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a feature rebase conflict aborts and restores a clean feature branch", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "shared.txt", "one\ntwo\nthree\n");
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    runGit(repo, ["checkout", "-q", "main"]);
    writeFile(repo, "shared.txt", "one\nMAIN\nthree\n");
    runGit(repo, ["commit", "-q", "-am", "main change"]);
    const mainBefore = gitOutput(repo, ["rev-parse", "main"]);
    runGit(repo, ["checkout", "-q", "feature"]);
    writeFile(repo, "shared.txt", "one\nFEATURE\nthree\n");
    const { code, result } = land(repo, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_CONFLICT");
    assert.equal(code, 23);
    assert.deepEqual(result.conflicts, ["shared.txt"]);
    assert.equal(gitOutput(repo, ["rev-parse", "main"]), mainBefore);
    assert.equal(gitOutput(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
    assert.equal(gitOutput(repo, ["status", "--short"]), "");
  } finally {
    cleanup(repo);
  }
});

test("a mainline checked out in a clean worktree is fast-forwarded there", () => {
  const { origin, seed } = seedOrigin();
  const holder = cloneRepo(origin);
  const session = path.join(path.dirname(holder), "session");
  try {
    runGit(holder, ["worktree", "add", "-b", "feature", session, "origin/feature"]);
    writeFile(session, "base.txt", "base\nfeature change\n");
    const { result } = land(session, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(gitOutput(holder, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
    assert.match((result.warnings as string[]).join("\n"), /fast-forwarded in its holding worktree/);
  } finally {
    cleanup(origin, seed, path.dirname(holder));
  }
});

test("a mainline checked out in a dirty worktree stops promotion", () => {
  const { origin, seed } = seedOrigin();
  const holder = cloneRepo(origin);
  const session = path.join(path.dirname(holder), "session");
  try {
    runGit(holder, ["worktree", "add", "-b", "feature", session, "origin/feature"]);
    writeFile(holder, "base.txt", "base\nholder dirty\n");
    writeFile(session, "base.txt", "base\nfeature change\n");
    const mainBefore = gitOutput(holder, ["rev-parse", "main"]);
    const { result } = land(session, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.equal(gitOutput(holder, ["rev-parse", "main"]), mainBefore);
    assert.match((result.warnings as string[]).join("\n"), /has uncommitted changes/);
  } finally {
    cleanup(origin, seed, path.dirname(holder));
  }
});

test("a clean tree still promotes an unlanded feature tip", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    commitFile(local, "feature-only.txt", "feature advance\n", "feature advance");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(code, 13);
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), gitOutput(local, ["rev-parse", "feature"]));
  } finally {
    cleanup(origin, seed, local);
  }
});

test("mainline promotion deletes a merged glissa remote branch", () => {
  const featureBranch = "glissa/session/delete-after-mainline";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.deletedRemoteBranches, [featureBranch]);
    assert.notEqual(tryGit(origin, ["rev-parse", "-q", "--verify", featureBranch]), 0);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a refused glissa branch deletion is only a warning", () => {
  const featureBranch = "glissa/session/delete-rejected";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    writeOriginHook(origin, "update", rejectDeleteHook(featureBranch));
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", featureBranch]), 0);
    assert.match((result.warnings as string[]).join("\n"), /could not delete merged remote branch/);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a non-glissa feature branch is never deleted after promotion", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("--promote-to is rejected as an unknown flag", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-unknown-flag-"));
  try {
    const { code, result, stderr } = runSkillScript(
      "land.ts",
      repo,
      ["--promote-to", "main"],
      VALID_MESSAGE,
    );
    assert.equal(code, 1);
    assert.deepEqual(result, {});
    assert.match(stderr, /unknown flag --promote-to/);
  } finally {
    cleanup(repo);
  }
});
