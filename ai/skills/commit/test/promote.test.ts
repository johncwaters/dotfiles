import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findWorktreeForBranch } from "../lib/workspace.ts";
import { Git } from "../lib/git.ts";
import {
  cleanup,
  cloneRepo,
  commitFile,
  gitOutput,
  land,
  makeBareOrigin,
  makeLedgerPath,
  makePolicyRoot,
  makeRepo,
  parkedEntryFixture,
  REAL_GIT_PATH,
  runGit,
  runSkillScript,
  tryGit,
  VALID_MESSAGE,
  writeExecutable,
  writeFile,
} from "./helpers.ts";
import { parseLedger } from "../lib/ledger.ts";

type PromotionSetup = { origin: string; seed: string; local: string };

function seedOrigin(featureBranch = "feature", branchesOnOrigin: string[] = []): PromotionSetup {
  const origin = makeBareOrigin();
  const seed = makeRepo();
  runGit(seed, ["remote", "add", "origin", origin]);
  commitFile(seed, "base.txt", "base\n", "init");
  runGit(seed, ["push", "-q", "-u", "origin", "main"]);
  runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const branchOnOrigin of branchesOnOrigin) {
    runGit(seed, ["branch", branchOnOrigin]);
    runGit(seed, ["push", "-q", "origin", branchOnOrigin]);
  }
  runGit(seed, ["checkout", "-q", "-b", featureBranch]);
  runGit(seed, ["push", "-q", "-u", "origin", featureBranch]);
  const local = cloneRepo(origin);
  runGit(local, ["checkout", "-q", "-b", featureBranch, `origin/${featureBranch}`]);
  return { origin, seed, local };
}

function writeOriginHook(origin: string, name: string, body: string): void {
  writeExecutable(path.join(origin, "hooks", name), body);
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

function gitWrapperInterceptingDeleteOf(branch: string): string {
  return [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    `const realGitPath = ${JSON.stringify(REAL_GIT_PATH)};`,
    `const isBranchDeletion = process.argv[2] === "push" && process.argv.includes(":refs/heads/${branch}");`,
    'const argumentsBeforeDeletion = JSON.parse(process.env.GIT_ARGS_BEFORE_DELETION ?? "[]");',
    'const argumentsAfterDeletion = JSON.parse(process.env.GIT_ARGS_AFTER_DELETION ?? "[]");',
    "if (isBranchDeletion && argumentsBeforeDeletion.length > 0) {",
    '  const raced = spawnSync(realGitPath, argumentsBeforeDeletion, { stdio: "inherit" });',
    "  if ((raced.status ?? 1) !== 0) process.exit(1);",
    "}",
    'const forwarded = spawnSync(realGitPath, process.argv.slice(2), { stdio: "inherit" });',
    "if (isBranchDeletion && argumentsAfterDeletion.length > 0) {",
    '  const trailing = spawnSync(realGitPath, argumentsAfterDeletion, { stdio: "inherit" });',
    "  if ((trailing.status ?? 1) !== 0) process.exit(1);",
    "}",
    "process.exit(forwarded.status ?? 1);",
    "",
  ].join("\n");
}

function seedMergeDriverDivergence(): PromotionSetup {
  const { origin, seed, local } = seedOrigin();
  runGit(seed, ["checkout", "-q", "feature"]);
  commitFile(seed, ".gitattributes", "* merge=ours\n", "attributes");
  commitFile(seed, "base.txt", "feature side\n", "feature side");
  runGit(seed, ["push", "-q", "origin", "feature"]);
  runGit(seed, ["checkout", "-q", "main"]);
  commitFile(seed, ".gitattributes", "* merge=ours\n", "attributes");
  commitFile(seed, "base.txt", "main side\n", "main side");
  runGit(seed, ["push", "-q", "origin", "main"]);
  runGit(local, ["fetch", "-q", "origin"]);
  runGit(local, ["merge", "-q", "--ff-only", "origin/feature"]);
  writeFile(local, "unrelated.txt", "unrelated\n");
  return { origin, seed, local };
}

function seedUnionOverwriteDivergence(): PromotionSetup {
  const { origin, seed, local } = seedOrigin();
  runGit(seed, ["checkout", "-q", "main"]);
  commitFile(seed, ".gitattributes", "* merge=union\n", "attributes");
  commitFile(seed, "shared.txt", "first\nsecond\nthird\n", "shared base");
  runGit(seed, ["push", "-q", "origin", "main"]);
  runGit(seed, ["checkout", "-q", "feature"]);
  runGit(seed, ["merge", "-q", "--ff-only", "main"]);
  commitFile(seed, "shared.txt", "first\nthird\n", "feature drops the middle line");
  runGit(seed, ["push", "-q", "origin", "feature"]);
  runGit(seed, ["checkout", "-q", "main"]);
  commitFile(seed, "shared.txt", "first\nsecond edited\nthird\n", "main rewrites the middle line");
  runGit(seed, ["push", "-q", "origin", "main"]);
  runGit(local, ["fetch", "-q", "origin"]);
  runGit(local, ["merge", "-q", "--ff-only", "origin/feature"]);
  writeFile(local, "unrelated.txt", "unrelated\n");
  return { origin, seed, local };
}

function assertContainmentRefusedAndBranchKept(
  result: Record<string, unknown>,
  origin: string,
): void {
  assert.equal(result.outcome, "COMMITTED");
  assert.equal("deletedRemoteBranches" in result, false);
  assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
  assert.match((result.warnings as string[]).join("\n"), /tree containment failed/);
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
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(result.pushed, false);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
    assert.notEqual(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
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

test("land refuses a forbidden branch before committing under policy and fallback guards", () => {
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "main",
    afterCommit: "promote",
  });
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-no-policy-"));
  for (const root of [policyRoot, fallbackRoot]) {
    const repo = makeRepo();
    try {
      commitFile(repo, "base.txt", "base\n", "init");
      const mainBefore = gitOutput(repo, ["rev-parse", "main"]);
      writeFile(repo, "base.txt", "base\nmain change\n");
      const { code, result } = runSkillScript(
        "land.ts",
        repo,
        ["--push-retry-delay-ms", "0", "--promote"],
        VALID_MESSAGE,
        { CLAUDE_COMMIT_POLICY_ROOT: root },
      );

      assert.equal(result.outcome, "BRANCH_FORBIDDEN");
      assert.equal(code, 28);
      assert.equal(result.branch, "main");
      assert.equal(gitOutput(repo, ["rev-parse", "main"]), mainBefore);
      assert.match(gitOutput(repo, ["status", "--short"]), /base\.txt/);
    } finally {
      cleanup(repo);
    }
  }
  cleanup(policyRoot, fallbackRoot);
});

test("committing on a resolved mainline outside the forbid list is BRANCH_FORBIDDEN", () => {
  const origin = makeBareOrigin();
  const seed = makeRepo("trunk");
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main", "master"], onForbidden: "create-feature-branch" },
    mainline: "auto",
    afterCommit: "promote",
  });
  try {
    commitFile(seed, "base.txt", "base\n", "init");
    runGit(seed, ["remote", "add", "origin", origin]);
    runGit(seed, ["push", "-q", "-u", "origin", "trunk"]);
    runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    const local = cloneRepo(origin);
    try {
      const headBefore = gitOutput(local, ["rev-parse", "HEAD"]);
      writeFile(local, "base.txt", "base\ntrunk change\n");

      const preflightResult = runSkillScript(
        "preflight.ts",
        local,
        [],
        "",
        { CLAUDE_COMMIT_POLICY_ROOT: policyRoot },
      );
      const { code, result } = runSkillScript(
        "land.ts",
        local,
        ["--push-retry-delay-ms", "0", "--no-push"],
        VALID_MESSAGE,
        { CLAUDE_COMMIT_POLICY_ROOT: policyRoot },
      );

      assert.equal(preflightResult.result.branchAllowed, false);
      assert.equal(result.outcome, "BRANCH_FORBIDDEN");
      assert.equal(code, 28);
      assert.equal(result.branch, "trunk");
      assert.equal(gitOutput(local, ["rev-parse", "HEAD"]), headBefore);
      assert.match(gitOutput(local, ["status", "--short"]), /base\.txt/);
    } finally {
      cleanup(local);
    }
  } finally {
    cleanup(origin, seed, policyRoot);
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

test("a remote-only mainline is materialized as a local tracking branch before promotion", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["branch", "-D", "main"]);
    assert.notEqual(tryGit(local, ["rev-parse", "-q", "--verify", "refs/heads/main"]), 0);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
    assert.equal(
      gitOutput(local, ["for-each-ref", "--format=%(upstream:short)", "refs/heads/main"]),
      "origin/main",
    );
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a failed mainline fetch returns MAINLINE_UNVERIFIED and never creates origin mainline", () => {
  const origin = makeBareOrigin();
  const repo = makeRepo();
  try {
    commitFile(repo, "base.txt", "base\n", "init");
    const localMainBefore = gitOutput(repo, ["rev-parse", "main"]);
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    runGit(repo, ["remote", "add", "origin", origin]);
    runGit(repo, ["push", "-q", "-u", "origin", "feature"]);
    writeFile(repo, "base.txt", "base\nfeature change\n");

    const { code, result } = land(repo, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "MAINLINE_UNVERIFIED");
    assert.equal(code, 29);
    assert.equal(result.mainline, "main");
    assert.equal(result.pushed, true);
    assert.equal(gitOutput(repo, ["rev-parse", "main"]), localMainBefore);
    assert.notEqual(tryGit(origin, ["rev-parse", "-q", "--verify", "refs/heads/main"]), 0);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), result.commit);
    assert.match((result.warnings as string[]).join("\n"), /could not verify origin\/main/);
  } finally {
    cleanup(origin, repo);
  }
});

test("an ahead mainline preserves mainline refs and safety-pushes the feature", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    const localOnlyCommit = gitOutput(local, ["rev-parse", "main"]);
    runGit(local, ["checkout", "-q", "feature"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "MAINLINE_AHEAD");
    assert.equal(code, 26);
    assert.equal(result.mainline, "main");
    assert.equal(result.pushed, true);
    assert.deepEqual(result.localOnlyCommits, [localOnlyCommit]);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), localOnlyCommit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), result.commit);
    assert.equal(gitOutput(local, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a diverged mainline preserves mainline refs and safety-pushes the feature", () => {
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
    writeFile(local, "base.txt", "base\nfeature change\n");
    const { code, result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_CONFLICT");
    assert.equal(code, 23);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.pushed, true);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), localMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), result.commit);
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

test("a promotion conflict records the parked feature branch", () => {
  const { origin, seed, local } = seedOrigin();
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "base.txt", "base\nmain change\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: ledgerPath,
    });
    const [entry] = parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries;

    assert.equal(result.outcome, "PROMOTE_CONFLICT");
    assert.equal(entry?.branch, "feature");
    assert.equal(entry?.commit, result.commit);
    assert.equal(entry?.outcome, "PROMOTE_CONFLICT");
    assert.deepEqual(entry?.conflicts, ["base.txt"]);
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("a clean tree promotion conflict still records the parked feature branch", () => {
  const { origin, seed, local } = seedOrigin();
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    commitFile(local, "base.txt", "base\nfeature change\n", "feature change");
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "base.txt", "base\nmain change\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);

    const { result } = land(local, ["--promote"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: ledgerPath,
    });
    const [entry] = parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries;

    assert.equal(result.outcome, "PROMOTE_CONFLICT");
    assert.equal(entry?.branch, "feature");
    assert.equal(entry?.commit, gitOutput(local, ["rev-parse", "HEAD"]));
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("--no-push records a parked branch with pushed false", () => {
  const { origin, seed, local } = seedOrigin();
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    runGit(local, ["checkout", "-q", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--no-push"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: ledgerPath,
    });
    const [entry] = parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries;

    assert.equal(result.outcome, "MAINLINE_AHEAD");
    assert.equal(entry?.pushed, false);
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("an unwritable ledger keeps the promotion outcome and adds a warning", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    runGit(local, ["checkout", "-q", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--no-push"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: os.tmpdir(),
    });

    assert.equal(result.outcome, "MAINLINE_AHEAD");
    assert.match((result.warnings as string[]).join("\n"), /could not record parked branch/);
  } finally {
    cleanup(origin, seed, local);
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
    assert.equal(result.pushed, true);
    assert.equal(gitOutput(holder, ["rev-parse", "main"]), mainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), result.commit);
    assert.match((result.warnings as string[]).join("\n"), /has uncommitted changes/);
  } finally {
    cleanup(origin, seed, path.dirname(holder));
  }
});

test("--promote --no-push updates local mainline without pushing any ref", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    const originFeatureBefore = gitOutput(origin, ["rev-parse", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, false);
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(gitOutput(local, ["rev-parse", "main"]), result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), originFeatureBefore);
    assert.match((result.warnings as string[]).join("\n"), /--no-push left main unpushed/);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("--no-push suppresses the feature safety push on a mainline refusal", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(local, ["checkout", "-q", "main"]);
    commitFile(local, "local-only.txt", "local only\n", "local only");
    runGit(local, ["checkout", "-q", "feature"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    const originFeatureBefore = gitOutput(origin, ["rev-parse", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "MAINLINE_AHEAD");
    assert.equal(result.pushed, false);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), originFeatureBefore);
  } finally {
    cleanup(origin, seed, local);
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

test("mainline promotion deletes a merged remote branch", () => {
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

test("a refused merged remote branch deletion is only a warning", () => {
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

test("a rebased landing deletes the remote feature branch through tree containment", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "feature"]);
    commitFile(seed, "feature-work.txt", "feature work\n", "feature work");
    runGit(seed, ["push", "-q", "origin", "feature"]);
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "remote.txt", "remote advance\n", "remote advance");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["merge", "-q", "--ff-only", "origin/feature"]);
    const remoteFeatureTip = gitOutput(local, ["rev-parse", "origin/feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.notEqual(gitOutput(local, ["rev-parse", "main"]), remoteFeatureTip);
    assert.deepEqual(result.deletedRemoteBranches, ["feature"]);
    assert.notEqual(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a remote branch that gained commits after the local push is kept with a warning", () => {
  const { origin, seed, local } = seedOrigin();
  const advancing = cloneRepo(origin);
  try {
    runGit(advancing, ["checkout", "-q", "-b", "feature", "origin/feature"]);
    commitFile(advancing, "sneaky.txt", "unreviewed\n", "add unreviewed file");
    runGit(advancing, ["revert", "--no-edit", "HEAD"]);
    runGit(advancing, ["push", "-q", "origin", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
    assert.match(
      (result.warnings as string[]).join("\n"),
      /remote branch feature at [0-9a-f]+ carries commits this landing never rebased from [0-9a-f]+; keeping branch/,
    );
  } finally {
    cleanup(origin, seed, local, advancing);
  }
});

test("a local custom merge driver cannot make an unmerged remote branch look contained", () => {
  const { origin, seed, local } = seedMergeDriverDivergence();
  try {
    runGit(local, ["config", "merge.ours.driver", "true"]);

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assertContainmentRefusedAndBranchKept(result, origin);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("an included custom merge driver cannot make an unmerged remote branch look contained", () => {
  const { origin, seed, local } = seedMergeDriverDivergence();
  try {
    const includedConfigPath = path.join(local, ".git", "included-config");
    fs.writeFileSync(includedConfigPath, '[merge "ours"]\n\tdriver = true\n', "utf8");
    runGit(local, ["config", "include.path", includedConfigPath]);

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assertContainmentRefusedAndBranchKept(result, origin);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a worktree-scoped custom merge driver cannot make an unmerged remote branch look contained", () => {
  const { origin, seed, local } = seedMergeDriverDivergence();
  try {
    runGit(local, ["config", "extensions.worktreeConfig", "true"]);
    runGit(local, ["config", "--worktree", "merge.ours.driver", "true"]);

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assertContainmentRefusedAndBranchKept(result, origin);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("an environment-injected merge driver cannot make an unmerged remote branch look contained", () => {
  const { origin, seed, local } = seedMergeDriverDivergence();
  try {
    const { result } = runSkillScript(
      "land.ts",
      local,
      ["--push-retry-delay-ms", "0", "--promote"],
      VALID_MESSAGE,
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "merge.ours.driver",
        GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_PARAMETERS: "'merge.ours.driver=true'",
      },
    );

    assertContainmentRefusedAndBranchKept(result, origin);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a union merge driver cannot make an overwritten branch line look contained", () => {
  const { origin, seed, local } = seedUnionOverwriteDivergence();
  try {
    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assertContainmentRefusedAndBranchKept(result, origin);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a remote feature branch with an unmerged merge commit is kept with a warning", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    runGit(seed, ["checkout", "-q", "-b", "side"]);
    commitFile(seed, "remote-only.txt", "remote only\n", "remote only");
    runGit(seed, ["checkout", "-q", "feature"]);
    runGit(seed, ["merge", "-q", "--no-ff", "side", "-m", "merge remote changes"]);
    runGit(seed, ["push", "-q", "origin", "feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
    assert.match(
      (result.warnings as string[]).join("\n"),
      /remote branch feature at [0-9a-f]+ carries commits this landing never rebased/,
    );
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a remote branch cherry-picked then reverted from main is kept", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "feature"]);
    commitFile(seed, "reverted.txt", "remote only\n", "remote only");
    const remoteFeatureCommit = gitOutput(seed, ["rev-parse", "HEAD"]);
    runGit(seed, ["push", "-q", "origin", "feature"]);
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "main-before.txt", "main before cherry-pick\n", "main advance");
    runGit(seed, ["cherry-pick", remoteFeatureCommit]);
    runGit(seed, ["revert", "--no-edit", "HEAD"]);
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["merge", "-q", "--ff-only", "origin/feature"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
    assert.match((result.warnings as string[]).join("\n"), /tree differs from main; keeping branch/);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a whitespace-only remote variant is kept", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "feature"]);
    commitFile(seed, "spacing.txt", "value \n", "remote whitespace");
    runGit(seed, ["push", "-q", "origin", "feature"]);
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "spacing.txt", "value\n", "main whitespace");
    runGit(seed, ["push", "-q", "origin", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
    assert.match(
      (result.warnings as string[]).join("\n"),
      /remote branch feature at [0-9a-f]+ carries commits this landing never rebased/,
    );
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a branch named like a remote tag never deletes the tag", () => {
  const { origin, seed, local } = seedOrigin("v9");
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    runGit(seed, ["tag", "v9"]);
    runGit(seed, ["push", "-q", "origin", "refs/tags/v9"]);
    runGit(local, ["checkout", "-q", "v9"]);
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.deletedRemoteBranches, ["v9"]);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "refs/tags/v9"]), 0);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a stale branch deletion lease keeps the remote branch with a warning", () => {
  const { origin, seed, local } = seedOrigin();
  const advancing = cloneRepo(origin);
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-git-wrapper-"));
  const wrapperPath = path.join(wrapperDirectory, "git");
  try {
    runGit(advancing, ["checkout", "-q", "-b", "feature", "origin/feature"]);
    commitFile(advancing, "concurrent.txt", "concurrent advance\n", "concurrent advance");
    writeExecutable(wrapperPath, gitWrapperInterceptingDeleteOf("feature"));
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = runSkillScript(
      "land.ts",
      local,
      ["--push-retry-delay-ms", "0", "--promote"],
      VALID_MESSAGE,
      {
        GIT_ARGS_BEFORE_DELETION: JSON.stringify([
          "-C",
          advancing,
          "push",
          "-q",
          "origin",
          "feature",
        ]),
        PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      },
    );

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
    assert.match((result.warnings as string[]).join("\n"), /could not delete merged remote branch feature/);
  } finally {
    cleanup(origin, seed, local, advancing, wrapperDirectory);
  }
});

test("a mainline force-reset right after the deletion restores the remote branch", () => {
  const { origin, seed, local } = seedOrigin();
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-git-wrapper-"));
  const wrapperPath = path.join(wrapperDirectory, "git");
  try {
    const mainlineBeforePromotion = gitOutput(local, ["rev-parse", "origin/main"]);
    const remoteFeatureTip = gitOutput(local, ["rev-parse", "origin/feature"]);
    writeExecutable(wrapperPath, gitWrapperInterceptingDeleteOf("feature"));
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = runSkillScript(
      "land.ts",
      local,
      ["--push-retry-delay-ms", "0", "--promote"],
      VALID_MESSAGE,
      {
        GIT_ARGS_AFTER_DELETION: JSON.stringify([
          "--git-dir",
          origin,
          "update-ref",
          "refs/heads/main",
          mainlineBeforePromotion,
        ]),
        PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      },
    );

    assert.equal(result.outcome, "COMMITTED");
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), remoteFeatureTip);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainlineBeforePromotion);
    assert.match(
      (result.warnings as string[]).join("\n"),
      /origin\/main is at [0-9a-f]+, not the [0-9a-f]+ this landing pushed; restoring deleted remote branch feature at [0-9a-f]+/,
    );
  } finally {
    cleanup(origin, seed, local, wrapperDirectory);
  }
});

test("mainline is never deleted as a feature branch", () => {
  const { origin, seed, local } = seedOrigin("feature", ["release"]);
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["release"], onForbidden: "create-feature-branch" },
    mainline: "release",
    afterCommit: "promote",
  });
  try {
    runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/release"]);
    runGit(local, ["checkout", "-q", "main"]);
    const mainOnOriginBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nmainline change\n");
    const { result } = runSkillScript(
      "land.ts",
      local,
      ["--push-retry-delay-ms", "0", "--promote"],
      VALID_MESSAGE,
      { CLAUDE_COMMIT_POLICY_ROOT: policyRoot },
    );

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["release"]);
    assert.equal("deletedRemoteBranches" in result, false);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainOnOriginBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "release"]), result.commit);
  } finally {
    cleanup(origin, seed, local, policyRoot);
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

function parkedLine(gitCommonDir: string, repo: string, branch: string): string {
  return JSON.stringify(
    parkedEntryFixture({
      at: "2026-09-01T00:00:00.000Z",
      repo,
      gitCommonDir,
      branch,
      commit: "0123456789abcdef0123456789abcdef01234567",
      conflicts: [],
    }),
  );
}

function commonDirOf(repo: string): string {
  return gitOutput(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

test("a deferred feature push failure without a mainline records the parked branch", () => {
  const origin = makeBareOrigin();
  const local = makeRepo("feature");
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    commitFile(local, "base.txt", "base\n", "init");
    runGit(local, ["remote", "add", "origin", origin]);
    writeOriginHook(origin, "update", rejectUpdateHook("feature"));
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: ledgerPath,
    });
    const [entry] = parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries;

    assert.equal(result.outcome, "PUSH_FAILED");
    assert.match((result.warnings as string[]).join("\n"), /promotion skipped: no mainline/);
    assert.equal(entry?.branch, "feature");
    assert.equal(entry?.mainline, null);
    assert.equal(entry?.commit, result.commit);
  } finally {
    cleanup(origin, local, ledgerDirectory);
  }
});

test("a successful promotion clears the parked entry for that branch alone", () => {
  const { origin, seed, local } = seedOrigin();
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    const gitCommonDir = commonDirOf(local);
    const otherLine = parkedLine(gitCommonDir, local, "other");
    fs.writeFileSync(
      ledgerPath,
      `${parkedLine(gitCommonDir, local, "feature")}\n${otherLine}\n`,
      "utf8",
    );
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote"], VALID_MESSAGE, {
      CLAUDE_COMMIT_LEDGER: ledgerPath,
    });
    const entries = parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries;

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.deepEqual(
      entries.map((entry) => entry.branch),
      ["other"],
    );
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("a successful feature push clears the parked entry for that branch", () => {
  const { origin, seed, local } = seedOrigin();
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    fs.writeFileSync(ledgerPath, `${parkedLine(commonDirOf(local), local, "feature")}\n`, "utf8");
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, [], VALID_MESSAGE, { CLAUDE_COMMIT_LEDGER: ledgerPath });

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, true);
    assert.deepEqual(parseLedger(fs.readFileSync(ledgerPath, "utf8")).entries, []);
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});
