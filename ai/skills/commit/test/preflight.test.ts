import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Git } from "../lib/git.ts";
import {
  cleanup,
  cloneRepo,
  commitFile,
  gitOutput,
  makeBareOrigin,
  makePolicyRoot,
  makeRepo,
  preflight,
  REAL_GIT_PATH,
  runGit,
  runSkillScript,
  tryGit,
  VALID_MESSAGE,
  writeExecutable,
  writeFile,
} from "./helpers.ts";

test("a directory that is not a repo is NOT_A_REPO", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-bare-"));
  try {
    const { code, result } = preflight(outside);
    assert.equal(result.outcome, "NOT_A_REPO");
    assert.equal(code, 10);
  } finally {
    cleanup(outside);
  }
});

test("a detached HEAD is DETACHED_HEAD", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["checkout", "-q", "--detach", "HEAD"]);
    const { code, result } = preflight(repo);
    assert.equal(result.outcome, "DETACHED_HEAD");
    assert.equal(code, 11);
  } finally {
    cleanup(repo);
  }
});

test("an unborn branch is READY and reports its branch name", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "new.txt", "new\n");

    const { code, result } = preflight(repo);

    assert.equal(result.outcome, "READY");
    assert.equal(code, 0);
    assert.equal(result.branch, "main");
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.untracked, ["new.txt"]);
  } finally {
    cleanup(repo);
  }
});

test("a conflicted merge left in progress is OPERATION_IN_PROGRESS", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["branch", "other"]);
    commitFile(repo, "a.txt", "main side\n", "main change");
    runGit(repo, ["checkout", "-q", "other"]);
    commitFile(repo, "a.txt", "other side\n", "other change");
    assert.notEqual(tryGit(repo, ["merge", "--no-edit", "main"]), 0);

    const { code, result } = preflight(repo);
    assert.equal(result.outcome, "OPERATION_IN_PROGRESS");
    assert.equal(result.operation, "MERGE_HEAD");
    assert.equal(code, 12);
  } finally {
    cleanup(repo);
  }
});

test("a clean tree is READY with an empty scope", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    const { code, result } = preflight(repo);
    assert.equal(result.outcome, "READY");
    assert.equal(code, 0);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.untracked, []);
    assert.deepEqual(result.paths, []);
    assert.equal(result.branch, "main");
  } finally {
    cleanup(repo);
  }
});

test("two mainline commits ahead report freshness and one warning", () => {
  const origin = makeBareOrigin();
  const seed = makeRepo();
  try {
    commitFile(seed, "a.txt", "one\n");
    runGit(seed, ["remote", "add", "origin", origin]);
    runGit(seed, ["push", "-q", "-u", "origin", "main"]);
    const local = cloneRepo(origin);
    try {
      commitFile(seed, "b.txt", "two\n", "second");
      commitFile(seed, "c.txt", "three\n", "third");
      runGit(seed, ["push", "-q", "origin", "main"]);

      const { result } = preflight(local);

      assert.deepEqual(result.mainlineFreshness, { checked: true, mainline: "main", behind: 2 });
      assert.match((result.warnings as string[]).join("\n"), /2 commits behind origin\/main/);
    } finally {
      cleanup(local);
    }
  } finally {
    cleanup(origin, seed);
  }
});

test("an up-to-date mainline reports zero behind with no warning", () => {
  const origin = makeBareOrigin();
  const seed = makeRepo();
  try {
    commitFile(seed, "a.txt", "one\n");
    runGit(seed, ["remote", "add", "origin", origin]);
    runGit(seed, ["push", "-q", "-u", "origin", "main"]);
    const local = cloneRepo(origin);
    try {
      const { result } = preflight(local);

      assert.deepEqual(result.mainlineFreshness, { checked: true, mainline: "main", behind: 0 });
      assert.equal(/behind origin\/main/.test((result.warnings as string[]).join("\n")), false);
    } finally {
      cleanup(local);
    }
  } finally {
    cleanup(origin, seed);
  }
});

function markFetchesGitWrapper(): string {
  return [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    'import fs from "node:fs";',
    'if (process.argv[2] === "fetch") fs.appendFileSync(process.env.FETCH_MARKER ?? "", `${process.argv.slice(2).join(" ")}\\n`);',
    `const forwarded = spawnSync(${JSON.stringify(REAL_GIT_PATH)}, process.argv.slice(2), { stdio: "inherit" });`,
    "process.exit(forwarded.status ?? 1);",
    "",
  ].join("\n");
}

test("a dash-named default branch is fetched by refspec and prunes no tracking ref", () => {
  const origin = makeBareOrigin();
  const seed = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "auto",
    afterCommit: "promote",
  });
  try {
    commitFile(seed, "a.txt", "one\n");
    runGit(seed, ["remote", "add", "origin", origin]);
    runGit(seed, ["push", "-q", "origin", "main:refs/heads/--prune"]);
    runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/--prune"]);
    const local = cloneRepo(origin);
    try {
      runGit(local, ["update-ref", "refs/remotes/origin/stale", gitOutput(local, ["rev-parse", "HEAD"])]);

      const { result } = preflight(local, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

      assert.deepEqual(result.mainlineFreshness, {
        checked: true,
        mainline: "--prune",
        behind: 0,
      });
      assert.equal(tryGit(local, ["rev-parse", "-q", "--verify", "refs/remotes/origin/stale"]), 0);
    } finally {
      cleanup(local);
    }
  } finally {
    cleanup(origin, seed, policyRoot);
  }
});

test("--no-fetch omits mainline freshness without contacting origin", () => {
  const repo = makeRepo();
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-preflight-git-"));
  const fetchMarkerPath = path.join(wrapperDirectory, "fetch-marker");
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", "https://127.0.0.1:1/unreachable.git"]);
    writeExecutable(path.join(wrapperDirectory, "git"), markFetchesGitWrapper());

    const { result } = preflight(repo, ["--no-fetch"], {
      PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      FETCH_MARKER: fetchMarkerPath,
    });

    assert.equal(result.outcome, "READY");
    assert.equal("mainlineFreshness" in result, false);
    assert.equal(fs.existsSync(fetchMarkerPath), false);
  } finally {
    cleanup(repo, wrapperDirectory);
  }
});

test("no origin records an unchecked freshness result and stays READY", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");

    const { result } = preflight(repo);

    assert.equal(result.outcome, "READY");
    assert.deepEqual(result.mainlineFreshness, {
      checked: false,
      mainline: "main",
      reason: "origin remote is not configured",
    });
  } finally {
    cleanup(repo);
  }
});

test("an unreachable origin records unchecked freshness within the fetch timeout", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", "https://127.0.0.1:1/unreachable.git"]);
    const startedAt = Date.now();
    const { result } = preflight(repo);

    assert.ok(Date.now() - startedAt < 5_500);
    assert.deepEqual(result.mainlineFreshness, {
      checked: false,
      mainline: "main",
      reason: "could not fetch origin/main",
    });
  } finally {
    cleanup(repo);
  }
});

test("modified and untracked files are reported, denylisted paths are not", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, "new.txt", "new\n");
    writeFile(repo, "debug.log", "noise\n");
    writeFile(repo, "node_modules/pkg/index.js", "junk\n");
    writeFile(repo, ".env.local", "SECRET=1\n");
    const { result } = preflight(repo);
    assert.deepEqual(result.changed, ["a.txt"]);
    assert.deepEqual(result.untracked, ["new.txt"]);
    assert.deepEqual(result.paths, ["a.txt", "new.txt"]);
  } finally {
    cleanup(repo);
  }
});

test("--paths restricts the reported scope", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    commitFile(repo, "b.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, "b.txt", "two\n");
    const { result } = preflight(repo, ["--paths", "a.txt"]);
    assert.deepEqual(result.changed, ["a.txt"]);
    assert.deepEqual(result.paths, ["a.txt"]);
  } finally {
    cleanup(repo);
  }
});

test("a branch the applied profile forbids reports branchAllowed false", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main", "master"], onForbidden: "create-feature-branch" },
    mainline: "auto",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");

    const onMain = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });
    assert.equal(onMain.result.branch, "main");
    assert.equal(onMain.result.branchAllowed, false);
    assert.equal(onMain.result.profile, "personal");
    assert.equal("warnings" in onMain.result, false);

    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    const onFeature = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });
    assert.equal(onFeature.result.branchAllowed, true);
    assert.deepEqual((onFeature.result.policy as Record<string, unknown>).resolved, {
      mainline: "main",
    });
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("a retired forbidden-branch remedy refuses preflight and names the profile file", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("legacy", {
    profile: "legacy",
    commitBranches: { forbid: ["main"], onForbidden: "switch-to-develop" },
    mainline: "auto",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    const { code, result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.equal(result.outcome, "POLICY_INVALID");
    assert.equal(code, 27);
    assert.match(
      (result.errors as string[]).join("\n"),
      /profiles\/legacy\/commit-policy\.json/,
    );
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("a literal policy mainline resolves into preflight policy output", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "main",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.deepEqual((result.policy as Record<string, unknown>).resolved, { mainline: "main" });
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("auto mainline prefers origin HEAD over a different local main branch", () => {
  const origin = makeBareOrigin();
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "auto",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", origin]);
    runGit(repo, ["push", "-q", "origin", "main"]);
    runGit(repo, ["checkout", "-q", "-b", "trunk"]);
    runGit(repo, ["push", "-q", "origin", "trunk"]);
    runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    runGit(repo, ["remote", "set-head", "origin", "-a"]);
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.deepEqual((result.policy as Record<string, unknown>).resolved, { mainline: "trunk" });
  } finally {
    cleanup(origin, repo, policyRoot);
  }
});

test("a mismatched release integration warns without refusing preflight", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "main",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, ".claude/release-profile.yml", "git:\n  integration: staging\n");
    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.equal(result.outcome, "READY");
    assert.match((result.warnings as string[]).join("\n"), /staging.*main/);
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("the live JSON release profile is preferred when both profile formats exist", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "main",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(
      repo,
      ".claude/release-profile.json",
      `${JSON.stringify({ git: { integration: "staging" } }, null, 2)}\n`,
    );
    writeFile(repo, ".claude/release-profile.yml", "git:\n  integration: retired\n");

    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.equal(result.outcome, "READY");
    const warnings = (result.warnings as string[]).join("\n");
    assert.match(warnings, /release-profile\.json.*staging.*main/);
    assert.equal(/retired/.test(warnings), false);
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("an unresolved policy mainline stays READY with a warning", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", {
    profile: "personal",
    commitBranches: { forbid: ["main"], onForbidden: "create-feature-branch" },
    mainline: "missing-trunk",
    afterCommit: "promote",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.equal(result.outcome, "READY");
    assert.deepEqual((result.policy as Record<string, unknown>).resolved, { mainline: null });
    assert.match((result.warnings as string[]).join("\n"), /promotion will be skipped/);
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("a machine with no applied profile still guards mainline", () => {
  const repo = makeRepo();
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-noprofile-"));
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");

    const { result } = preflight(repo, [], { CLAUDE_COMMIT_POLICY_ROOT: emptyRoot });

    assert.equal(result.branchAllowed, false);
    assert.equal("policy" in result, false);
    assert.match((result.warnings as string[]).join("\n"), /no machine profile marker/);
  } finally {
    cleanup(repo, emptyRoot);
  }
});

test("--check-message accepts a valid message and rejects an invalid one", () => {
  const repo = makeRepo();
  try {
    const good = runSkillScript("preflight.ts", repo, ["--check-message"], VALID_MESSAGE);
    assert.equal(good.result.outcome, "READY");
    assert.equal(good.code, 0);

    const bad = runSkillScript("preflight.ts", repo, ["--check-message"], "not a conventional header");
    assert.equal(bad.result.outcome, "MESSAGE_INVALID");
    assert.equal(bad.code, 20);
    assert.ok((bad.result.errors as string[]).length > 0);
  } finally {
    cleanup(repo);
  }
});

test("--check-message does not fetch origin", () => {
  const repo = makeRepo();
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-check-message-git-"));
  const fetchMarkerPath = path.join(wrapperDirectory, "fetch-marker");
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", "https://127.0.0.1:1/unreachable.git"]);
    writeExecutable(path.join(wrapperDirectory, "git"), markFetchesGitWrapper());

    const good = runSkillScript("preflight.ts", repo, ["--check-message"], VALID_MESSAGE, {
      PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      FETCH_MARKER: fetchMarkerPath,
    });

    assert.equal(good.result.outcome, "READY");
    assert.equal(good.code, 0);
    assert.equal("mainlineFreshness" in good.result, false);
    assert.equal(fs.existsSync(fetchMarkerPath), false);
  } finally {
    cleanup(repo, wrapperDirectory);
  }
});

test("a failed empty tree hash on an unborn branch throws instead of reporting no changes", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "new.txt", "new\n");
    runGit(repo, ["add", "--", "new.txt"]);
    const git = new Git(repo);
    const realRun = git.run.bind(git);
    git.run = (args, options) => {
      if (args[0] === "hash-object") {
        return { code: 128, stdout: "", stderr: "fatal: unable to hash the empty tree" };
      }
      return realRun(args, options);
    };

    assert.throws(() => git.diffNameOnly(), /hash-object .* unable to hash the empty tree/);
  } finally {
    cleanup(repo);
  }
});
