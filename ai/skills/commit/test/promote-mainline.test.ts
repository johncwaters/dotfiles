import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseLedger } from "../lib/ledger.ts";
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
  runGit,
  runSkillScript,
  seedOrigin,
  tryGit,
  VALID_MESSAGE,
  writeExecutable,
  writeFile,
  writeOriginHook,
} from "./helpers.ts";

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
  const featureBranch = "glimmervoid/session/promotion-fallback";
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

for (const readOnlyPart of ["index", "working tree"] as const) {
  test(`a mainline checked out with a read-only ${readOnlyPart} is pushed to origin without touching that checkout`, () => {
    const { origin, seed } = seedOrigin();
    const holder = cloneRepo(origin);
    const session = path.join(path.dirname(holder), "session");
    const readOnlyPath = readOnlyPart === "index" ? path.join(holder, ".git", "index") : holder;
    try {
      runGit(holder, ["worktree", "add", "-b", "feature", session, "origin/feature"]);
      advanceOriginMain(seed, "mainline.txt");
      writeFile(session, "base.txt", "base\nfeature change\n");
      const mainBefore = gitOutput(holder, ["rev-parse", "main"]);
      fs.chmodSync(readOnlyPath, readOnlyPart === "index" ? 0o444 : 0o555);
      const { result } = land(session, ["--promote"], VALID_MESSAGE);

      assert.equal(result.outcome, "COMMITTED");
      assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
      assert.equal(gitOutput(origin, ["rev-parse", `${result.commit}^`]), gitOutput(seed, ["rev-parse", "main"]));
      assert.equal(gitOutput(holder, ["rev-parse", "main"]), mainBefore);
      assert.equal(gitOutput(holder, ["status", "--porcelain"]), "");
      assert.match((result.warnings as string[]).join("\n"), /checked out read-only/);
    } finally {
      fs.chmodSync(readOnlyPath, 0o755);
      cleanup(origin, seed, path.dirname(holder));
    }
  });
}

for (const readOnlyPart of ["server", ".git/refs/heads"]) {
  test(`a mainline checkout writable at its top but read-only below at ${readOnlyPart} is pushed to origin without a partial merge`, () => {
    const { origin, seed } = seedOrigin();
    const holder = cloneRepo(origin);
    const session = path.join(path.dirname(holder), "session");
    const readOnlyDirectory = path.join(holder, readOnlyPart);
    try {
      advanceOriginMain(seed, "server/core.txt");
      runGit(holder, ["pull", "-q", "--ff-only"]);
      runGit(holder, ["worktree", "add", "-b", "glimmervoid/session/feature", session, "origin/main"]);
      writeFile(session, "base.txt", "base\nfeature change\n");
      writeFile(session, "server/core.txt", "mainline change\nfeature change\n");
      writeFile(session, "newdir/new.txt", "new\n");
      const mainBefore = gitOutput(holder, ["rev-parse", "main"]);
      fs.chmodSync(readOnlyDirectory, 0o555);
      const { result } = land(
        session,
        ["--promote", "--paths", "base.txt", "server/core.txt", "newdir/new.txt"],
        VALID_MESSAGE,
      );

      assert.equal(result.outcome, "COMMITTED");
      assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
      assert.equal(gitOutput(holder, ["rev-parse", "main"]), mainBefore);
      assert.equal(gitOutput(holder, ["status", "--porcelain"]), "");
      assert.match((result.warnings as string[]).join("\n"), /checked out read-only/);
    } finally {
      fs.chmodSync(readOnlyDirectory, 0o755);
      cleanup(origin, seed, path.dirname(holder));
    }
  });
}

test("a mainline checked out read-only stops promotion under --no-push", () => {
  const { origin, seed } = seedOrigin();
  const holder = cloneRepo(origin);
  const session = path.join(path.dirname(holder), "session");
  try {
    runGit(holder, ["worktree", "add", "-b", "feature", session, "origin/feature"]);
    writeFile(session, "base.txt", "base\nfeature change\n");
    const localMainBefore = gitOutput(holder, ["rev-parse", "main"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "main"]);
    fs.chmodSync(path.join(holder, ".git", "index"), 0o444);
    const { result } = land(session, ["--promote", "--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.ok(!(result.promoted as string[]).includes("main"));
    assert.equal(gitOutput(holder, ["rev-parse", "main"]), localMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), originMainBefore);
  } finally {
    cleanup(origin, seed, path.dirname(holder));
  }
});

test("a mainline checked out read-only stops promotion without an origin", () => {
  const holder = makeRepo();
  const session = `${holder}-session`;
  try {
    commitFile(holder, "base.txt", "base\n", "init");
    runGit(holder, ["worktree", "add", "-b", "feature", session, "main"]);
    writeFile(session, "base.txt", "base\nfeature change\n");
    const mainBefore = gitOutput(holder, ["rev-parse", "main"]);
    fs.chmodSync(path.join(holder, ".git", "index"), 0o444);
    const { result } = land(session, ["--promote"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.ok(!(result.promoted as string[]).includes("main"));
    assert.equal(gitOutput(holder, ["rev-parse", "main"]), mainBefore);
  } finally {
    cleanup(holder, session);
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

function advanceOriginMain(seed: string, filePath: string): void {
  runGit(seed, ["checkout", "-q", "main"]);
  commitFile(seed, filePath, "mainline change\n", "mainline moves");
  runGit(seed, ["push", "-q", "origin", "main"]);
}

test("promotion rebases past another ticket's uncommitted files left outside --paths", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    commitFile(local, "other-ticket.txt", "committed\n", "other ticket base");
    advanceOriginMain(seed, "mainline.txt");
    writeFile(local, "other-ticket.txt", "committed\nin progress\n");
    writeFile(local, "other-ticket-new.txt", "untracked\n");
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--paths", "base.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(result.promoted, ["main"]);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), result.commit);
    assert.equal(fs.readFileSync(path.join(local, "other-ticket.txt"), "utf8"), "committed\nin progress\n");
    assert.equal(fs.readFileSync(path.join(local, "other-ticket-new.txt"), "utf8"), "untracked\n");
    assert.equal(gitOutput(local, ["stash", "list"]), "");
  } finally {
    cleanup(origin, seed, local);
  }
});

test("promotion leaves the branch unmoved when an uncommitted file is one mainline changed", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    runGit(seed, ["checkout", "-q", "main"]);
    commitFile(seed, "shared.txt", "committed\n", "shared base");
    runGit(seed, ["push", "-q", "origin", "main"]);
    runGit(local, ["pull", "-q", "--ff-only", "origin", "main"]);
    advanceOriginMain(seed, "shared.txt");
    writeFile(local, "shared.txt", "committed\nin progress\n");
    writeFile(local, "base.txt", "base\nfeature change\n");
    const featureTipBefore = gitOutput(local, ["rev-parse", "HEAD"]);

    const { result } = land(local, ["--promote", "--paths", "base.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.equal(gitOutput(local, ["rev-parse", "HEAD~1"]), featureTipBefore);
    assert.equal(fs.readFileSync(path.join(local, "shared.txt"), "utf8"), "committed\nin progress\n");
    assert.match((result.warnings as string[]).join("\n"), /shared\.txt/);
    assert.equal(gitOutput(local, ["stash", "list"]), "");
  } finally {
    cleanup(origin, seed, local);
  }
});

test("a refusing pre-rebase hook stops promotion without touching uncommitted files or leaking a worktree", () => {
  const { origin, seed, local } = seedOrigin();
  try {
    commitFile(local, "other-ticket.txt", "committed\n", "other ticket base");
    advanceOriginMain(seed, "mainline.txt");
    writeExecutable(path.join(local, ".git", "hooks", "pre-rebase"), "#!/bin/sh\nexit 1\n");
    writeFile(local, "other-ticket.txt", "committed\nin progress\n");
    writeFile(local, "base.txt", "base\nfeature change\n");

    const { result } = land(local, ["--promote", "--paths", "base.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "PROMOTE_FAILED");
    assert.match((result.warnings as string[]).join("\n"), /pre-rebase hook refused/);
    assert.equal(fs.readFileSync(path.join(local, "other-ticket.txt"), "utf8"), "committed\nin progress\n");
    assert.equal(fs.existsSync(path.join(local, ".git", "rebase-merge")), false);
    assert.equal(gitOutput(local, ["stash", "list"]), "");
    const registeredWorktrees = gitOutput(local, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    assert.equal(registeredWorktrees.length, 1);
  } finally {
    cleanup(origin, seed, local);
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
