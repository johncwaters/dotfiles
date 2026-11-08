import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cleanup,
  cloneRepo,
  commitFile,
  gitOutput,
  land,
  makeLedgerPath,
  makePolicyRoot,
  REAL_GIT_PATH,
  runGit,
  runSkillScript,
  seedOrigin,
  tryGit,
  VALID_MESSAGE,
  writeExecutable,
  writeFile,
  writeOriginHook,
} from "./helpers.ts";
import type { PromotionSetup } from "./helpers.ts";

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

function assertContainmentRefusedAndBranchKept(
  result: Record<string, unknown>,
  origin: string,
): void {
  assert.equal(result.outcome, "COMMITTED");
  assert.equal("deletedRemoteBranches" in result, false);
  assert.equal(tryGit(origin, ["rev-parse", "-q", "--verify", "feature"]), 0);
  assert.match((result.warnings as string[]).join("\n"), /tree containment failed/);
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

test("mainline promotion deletes a merged remote branch", () => {
  const featureBranch = "glimmervoid/session/delete-after-mainline";
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
  const featureBranch = "glimmervoid/session/delete-rejected";
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
    const { result } = land(local, ["--promote"],
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

    const { result, stderr } = land(local, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED", stderr);
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

    const { result } = land(local, ["--promote"],
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

    const { result } = land(local, ["--promote"],
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
  });
  try {
    runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/release"]);
    runGit(local, ["checkout", "-q", "main"]);
    const mainOnOriginBefore = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "base.txt", "base\nmainline change\n");
    const { result } = land(local, ["--promote"],
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

test("a rerun after a promotion conflict resolved by hand keeps the remote branch whose pre-resolution commit main lacks", () => {
  const featureBranch = "glimmervoid/session/hand-resolved-conflict";
  const { origin, seed, local } = seedOrigin(featureBranch);
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  const ledgerEnv = { CLAUDE_COMMIT_LEDGER: ledgerPath };
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "base.txt", "base\nmain change\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const conflicted = land(local, ["--promote"], VALID_MESSAGE, ledgerEnv);
    assert.equal(conflicted.result.outcome, "PROMOTE_CONFLICT");
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), conflicted.result.commit);

    runGit(local, ["fetch", "-q", "origin"]);
    assert.notEqual(tryGit(local, ["rebase", "origin/main"]), 0);
    writeFile(local, "base.txt", "base\nmain change\nfeature change\n");
    runGit(local, ["add", "base.txt"]);
    runGit(local, ["-c", "core.editor=true", "rebase", "--continue"]);
    const rerun = land(local, ["--promote"], "", ledgerEnv);

    assert.deepEqual(rerun.result.promoted, ["main"]);
    assert.equal(rerun.result.deletedRemoteBranches, undefined);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), conflicted.result.commit);
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("a later landing deletes a remote branch whose only commits main lacks are empty ours-merge markers, after main edits the same lines", () => {
  const featureBranch = "glimmervoid/session/empty-merge-marker";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    commitFile(local, "feature.txt", "feature\n", "feature work");
    const preRebaseCommit = gitOutput(local, ["rev-parse", "HEAD"]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`]);
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "main.txt", "main\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["rebase", "-q", "origin/main"]);
    runGit(local, ["merge", "-q", "-s", "ours", "-m", "record the pre-rebase tip as merged", preRebaseCommit]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`, "HEAD^:main"]);
    runGit(seed, ["fetch", "-q", "origin"]);
    runGit(seed, ["reset", "-q", "--hard", "origin/main"]);
    commitFile(seed, "feature.txt", "feature edited on main\n", "later edit of the same line");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["reset", "-q", "--hard", "origin/main"]);
    writeFile(local, "other.txt", "later work\n");
    const later = land(local, ["--promote"], VALID_MESSAGE);

    assert.deepEqual(later.result.promoted, ["main"]);
    assert.deepEqual(later.result.deletedRemoteBranches, [featureBranch], JSON.stringify(later.result.warnings));
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a later landing keeps a remote branch whose commit main reverted and then edited nearby", () => {
  const featureBranch = "glimmervoid/session/reverted-then-edited";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "shared.txt", "l1\nl2\nA\nl4\nl5\n", "shared file");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["reset", "-q", "--hard", "origin/main"]);
    commitFile(local, "shared.txt", "l1\nl2\nB\nl4\nl5\n", "feature work");
    const preRebaseCommit = gitOutput(local, ["rev-parse", "HEAD"]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`]);
    commitFile(seed, "main.txt", "main\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["rebase", "-q", "origin/main"]);
    runGit(local, ["merge", "-q", "-s", "ours", "-m", "record the pre-rebase tip as merged", preRebaseCommit]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`, "HEAD^:main"]);
    const markerTip = gitOutput(local, ["rev-parse", "HEAD"]);
    runGit(seed, ["fetch", "-q", "origin"]);
    runGit(seed, ["reset", "-q", "--hard", "origin/main"]);
    runGit(seed, ["revert", "--no-edit", "HEAD"]);
    commitFile(seed, "shared.txt", "l1\nl2\nA\nl4 edited\nl5\n", "edit a nearby line");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["reset", "-q", "--hard", "origin/main"]);
    writeFile(local, "other.txt", "later work\n");
    const later = land(local, ["--promote"], VALID_MESSAGE);

    assert.deepEqual(later.result.promoted, ["main"]);
    assert.equal(later.result.deletedRemoteBranches, undefined);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), markerTip);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a later landing keeps a remote branch whose amended commit main lacks behind an ours-merge marker", () => {
  const featureBranch = "glimmervoid/session/amended-behind-marker";
  const { origin, seed, local } = seedOrigin(featureBranch);
  try {
    commitFile(local, "feature.txt", "feature\n", "feature work");
    const landedCommit = gitOutput(local, ["rev-parse", "HEAD"]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`, "HEAD:main"]);
    writeFile(local, "feature.txt", "feature\nuncarried work\n");
    runGit(local, ["commit", "-q", "-a", "--amend", "--no-edit"]);
    runGit(local, ["merge", "-q", "-s", "ours", "-m", "record the landed commit as merged", landedCommit]);
    runGit(local, ["push", "-q", "origin", `HEAD:${featureBranch}`]);
    const uncarriedTip = gitOutput(local, ["rev-parse", "HEAD"]);
    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["reset", "-q", "--hard", "origin/main"]);
    writeFile(local, "other.txt", "later work\n");
    const later = land(local, ["--promote"], VALID_MESSAGE);

    assert.deepEqual(later.result.promoted, ["main"]);
    assert.equal(later.result.deletedRemoteBranches, undefined);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), uncarriedTip);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a rerun after a promotion conflict keeps the remote branch when the conflicted commit was dropped instead of carried", () => {
  const featureBranch = "glimmervoid/session/dropped-conflict";
  const { origin, seed, local } = seedOrigin(featureBranch);
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  const ledgerEnv = { CLAUDE_COMMIT_LEDGER: ledgerPath };
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "base.txt", "base\nmain change\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    const conflicted = land(local, ["--promote"], VALID_MESSAGE, ledgerEnv);
    assert.equal(conflicted.result.outcome, "PROMOTE_CONFLICT");

    runGit(local, ["fetch", "-q", "origin"]);
    runGit(local, ["reset", "-q", "--hard", "origin/main"]);
    writeFile(local, "other.txt", "unrelated\n");
    const rerun = land(local, ["--promote"], VALID_MESSAGE, ledgerEnv);

    assert.deepEqual(rerun.result.promoted, ["main"]);
    assert.equal(rerun.result.deletedRemoteBranches, undefined);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), conflicted.result.commit);
  } finally {
    cleanup(origin, seed, local, ledgerDirectory);
  }
});

test("a rerun after a promotion conflict keeps a remote branch amended elsewhere after the safety push", () => {
  const featureBranch = "glimmervoid/session/amended-elsewhere";
  const { origin, seed, local } = seedOrigin(featureBranch);
  const otherCheckout = cloneRepo(origin);
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  const ledgerEnv = { CLAUDE_COMMIT_LEDGER: ledgerPath };
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "base.txt", "base\nmain change\n", "main change");
    runGit(seed, ["push", "-q", "origin", "main"]);
    writeFile(local, "base.txt", "base\nfeature change\n");
    assert.equal(land(local, ["--promote"], VALID_MESSAGE, ledgerEnv).result.outcome, "PROMOTE_CONFLICT");

    runGit(otherCheckout, ["fetch", "-q", "origin"]);
    runGit(otherCheckout, ["checkout", "-q", "-b", featureBranch, `origin/${featureBranch}`]);
    writeFile(otherCheckout, "base.txt", "base\nfeature change\nwork only on the remote\n");
    runGit(otherCheckout, ["commit", "-q", "-a", "--amend", "--no-edit"]);
    runGit(otherCheckout, ["push", "-q", "-f", "origin", featureBranch]);
    const amendedTip = gitOutput(otherCheckout, ["rev-parse", "HEAD"]);

    runGit(local, ["fetch", "-q", "origin"]);
    assert.notEqual(tryGit(local, ["rebase", "origin/main"]), 0);
    writeFile(local, "base.txt", "base\nmain change\nfeature change\n");
    runGit(local, ["add", "base.txt"]);
    runGit(local, ["-c", "core.editor=true", "rebase", "--continue"]);
    const rerun = land(local, ["--promote"], "", ledgerEnv);

    assert.deepEqual(rerun.result.promoted, ["main"]);
    assert.equal(rerun.result.deletedRemoteBranches, undefined);
    assert.equal(gitOutput(origin, ["rev-parse", featureBranch]), amendedTip);
  } finally {
    cleanup(origin, seed, local, otherCheckout, ledgerDirectory);
  }
});
