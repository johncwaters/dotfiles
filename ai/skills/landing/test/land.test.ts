import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Git } from "../lib/git.ts";
import { stampLedgerPath } from "../lib/stamp.ts";
import { findWorktreeForBranch, listedUsernames } from "../lib/workspace.ts";
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
  runGit,
  runSkillScript,
  VALID_MESSAGE,
  landUnstamped,
  reviewGatesDirectory,
  seedOrigin,
  SKILL_DIR,
  stamp,
  tryGit,
  writeExecutable,
  writeFile,
  writeOriginHook,
} from "./helpers.ts";

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

function writeFailingHook(repo: string, name: string): void {
  const hooksDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, name);
  fs.writeFileSync(hookPath, "#!/bin/sh\nprintf ' src/a.ts\\t12:3 check output: gate failed\\n'\ngit rev-parse --verify refs/heads/absent\necho 'hook says no' >&2\nexit 1\n", "utf8");
  fs.chmodSync(hookPath, 0o755);
}

test("a real commit is created from the message in --message-file", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, "new.txt", "new\n");

    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.equal(result.commit, gitOutput(repo, ["rev-parse", "HEAD"]));
    assert.equal(gitOutput(repo, ["log", "-1", "--format=%B"]).trim(), VALID_MESSAGE);
    assert.deepEqual(gitOutput(repo, ["status", "--short"]), "");
  } finally {
    cleanup(repo);
  }
});

test("a repo requiring DCO lands a commit signed off with the configured identity", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, ".github/dco.yml", "require: true\n");

    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    const name = gitOutput(repo, ["config", "user.name"]);
    const email = gitOutput(repo, ["config", "user.email"]);
    assert.equal(
      gitOutput(repo, ["log", "-1", "--format=%B"]),
      `${VALID_MESSAGE}\nSigned-off-by: ${name} <${email}>`,
    );
    assert.deepEqual(gitOutput(repo, ["status", "--short"]), "");
  } finally {
    cleanup(repo);
  }
});

test("landing on an unborn feature branch creates the root commit", () => {
  const repo = makeRepo("feature");
  try {
    writeFile(repo, "new.txt", "new\n");

    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.equal(gitOutput(repo, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(gitOutput(repo, ["log", "-1", "--format=%s"]), "feat: add a thing");
  } finally {
    cleanup(repo);
  }
});

test("a path-scoped land on an unborn branch commits only the scoped file", () => {
  const repo = makeRepo("feature");
  try {
    writeFile(repo, "in.txt", "in\n");
    writeFile(repo, "out.txt", "out\n");
    runGit(repo, ["add", "in.txt", "out.txt"]);

    const { code, result } = land(repo, ["--no-push", "--paths", "in.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.equal(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]), "in.txt");
    assert.equal(fs.readFileSync(path.join(repo, "out.txt"), "utf8"), "out\n");
  } finally {
    cleanup(repo);
  }
});

test("a path-scoped land on an unborn branch unstages a file modified after staging", () => {
  const repo = makeRepo("feature");
  try {
    writeFile(repo, "in.txt", "in\n");
    writeFile(repo, "out.txt", "out\n");
    runGit(repo, ["add", "in.txt", "out.txt"]);
    writeFile(repo, "out.txt", "out modified\n");

    const { code, result } = land(repo, ["--no-push", "--paths", "in.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.equal(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]), "in.txt");
    assert.equal(fs.readFileSync(path.join(repo, "out.txt"), "utf8"), "out modified\n");
  } finally {
    cleanup(repo);
  }
});

for (const policyFileBody of [null, "null", "[]"]) {
test(`a missing commit policy${policyFileBody === null ? "" : ` (${policyFileBody})`} commits without promotion and names the reason`, () => {
  const repo = makeRepo("feature");
  const policyRoot = policyFileBody === null
    ? fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-no-policy-"))
    : makePolicyRoot("personal", {});
  if (policyFileBody !== null) {
    fs.writeFileSync(path.join(policyRoot, "profiles", "personal", "commit-policy.json"), policyFileBody);
  }
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");

    const { code, result } = land(repo, ["--promote"], VALID_MESSAGE, { CLAUDE_COMMIT_POLICY_ROOT: policyRoot });

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.deepEqual(result.promoted, []);
    assert.match((result.warnings as string[]).join("\n"), /promotion skipped: no commit policy: (no machine profile marker|.*holds no policy object)/);
  } finally {
    cleanup(repo, policyRoot);
  }
});
}

test("an invalid commit policy commits without promotion and names the profile file", () => {
  const repo = makeRepo("feature");
  const policyRoot = makePolicyRoot("legacy", {
    profile: "legacy",
    commitBranches: { forbid: ["main"], onForbidden: "switch-to-develop" },
    mainline: "main",
  });
  try {
    commitFile(repo, "a.txt", "one\n");
    const headBefore = gitOutput(repo, ["rev-parse", "HEAD"]);
    writeFile(repo, "a.txt", "two\n");

    const { code, result } = land(repo, ["--promote"],
      VALID_MESSAGE,
      { CLAUDE_COMMIT_POLICY_ROOT: policyRoot },
    );

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(code, 0);
    assert.deepEqual(result.promoted, []);
    assert.notEqual(gitOutput(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.match((result.warnings as string[]).join("\n"), /promotion skipped: invalid commit policy: .*profiles\/legacy\/commit-policy\.json/);
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("a clean tree without promotion is NOTHING_TO_COMMIT", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);
    assert.equal(result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(code, 13);
  } finally {
    cleanup(repo);
  }
});

test("an invalid message is MESSAGE_INVALID, commits nothing, and names the message fix as next", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    const head = gitOutput(repo, ["rev-parse", "HEAD"]);

    const { code, result } = land(repo, ["--no-push"], "no conventional header here");

    assert.equal(result.outcome, "MESSAGE_INVALID");
    assert.equal(code, 20);
    assert.deepEqual(result.next, { action: "fixAndRerun", fix: "message", items: result.errors });
    assert.equal(gitOutput(repo, ["rev-parse", "HEAD"]), head);
  } finally {
    cleanup(repo);
  }
});

test("a rejecting commit hook is HOOK_FAILED and keeps the hook stderr", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFailingHook(repo, "pre-commit");

    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "HOOK_FAILED");
    assert.equal(code, 21);
    assert.match((result.warnings as string[]).join("\n"), /hook says no/);
  } finally {
    cleanup(repo);
  }
});

test("--paths leaves an out-of-scope change dirty", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    commitFile(repo, "b.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, "b.txt", "two\n");

    const { result } = land(repo, ["--no-push", "--paths", "a.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), ["a.txt"]);
    assert.match(gitOutput(repo, ["status", "--short"]), /b\.txt/);
  } finally {
    cleanup(repo);
  }
});

test("--paths still commits Coherence journal files opened during review", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, ".coherence/decisions/review-lane.jsonl", "{}\n");
    writeFile(repo, ".coherence/decisions/intent-lane.jsonl", "{}\n");
    runGit(repo, ["add", "-N", ".coherence/decisions/intent-lane.jsonl"]);
    writeFile(repo, ".coherence/defects/s-review-lane.jsonl", "{}\n");
    writeFile(repo, "b.txt", "out of scope\n");

    const { result } = land(repo, ["--no-push", "--paths", "a.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort(), [
      ".coherence/decisions/intent-lane.jsonl",
      ".coherence/decisions/review-lane.jsonl",
      ".coherence/defects/s-review-lane.jsonl",
      "a.txt",
    ]);
    assert.match(gitOutput(repo, ["status", "--short"]), /b\.txt/);
  } finally {
    cleanup(repo);
  }
});

async function waitUntil(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!isDone() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("in a Coherence repo a follower lands the run journal written after the commit, never past uncommitted work, a moved HEAD, or --no-push", async () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, ".coherence/.gitignore", "/*\n!/.gitignore\n!/runs/\n");
    const followerPidPath = path.join(repo, ".git", "coherence-journal-follower.pid");
    const readFollowerPid = () => (fs.existsSync(followerPidPath) ? fs.readFileSync(followerPidPath, "utf8") : "");
    const landAndAwaitFollower = async (filePath: string, args: string[] = []) => {
      const previousFollowerPid = readFollowerPid();
      writeFile(repo, filePath, "one\n");
      assert.equal(land(repo, [...args, "--paths", filePath], VALID_MESSAGE).result.outcome, "COMMITTED");
      await waitUntil(() => readFollowerPid() !== previousFollowerPid);
    };
    const journalSubject = "chore(coherence): record run journal";

    await landAndAwaitFollower("a.txt");
    writeFile(repo, ".coherence/runs/turn-end.jsonl", "{}\n");
    await waitUntil(() => gitOutput(repo, ["log", "-1", "--format=%s"]) === journalSubject);
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=%s", "HEAD"]).split("\n").filter(Boolean), [
      journalSubject,
      ".coherence/runs/turn-end.jsonl",
    ]);

    await landAndAwaitFollower("b.txt");
    writeFile(repo, "c.txt", "in progress\n");
    writeFile(repo, ".coherence/runs/turn-end-2.jsonl", "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.match(gitOutput(repo, ["status", "--short"]), /turn-end-2\.jsonl/);
    fs.rmSync(path.join(repo, "c.txt"));

    await landAndAwaitFollower("d.txt");
    commitFile(repo, "e.txt", "unreviewed\n", "wip: unreviewed");
    writeFile(repo, ".coherence/runs/turn-end-3.jsonl", "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(gitOutput(repo, ["log", "-1", "--format=%s"]), "wip: unreviewed");

    const followerPidBeforeLocalOnlyLanding = readFollowerPid();
    writeFile(repo, "f.txt", "one\n");
    assert.equal(land(repo, ["--no-push", "--paths", "f.txt"], VALID_MESSAGE).result.outcome, "COMMITTED");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(readFollowerPid(), followerPidBeforeLocalOnlyLanding);
  } finally {
    cleanup(repo);
  }
});

test("--paths naming an already staged deletion still stages the other scoped changes", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    commitFile(repo, "gone.txt", "one\n");
    runGit(repo, ["rm", "--quiet", "gone.txt"]);
    writeFile(repo, "a.txt", "two\n");

    const { result } = land(repo, ["--no-push", "--paths", "a.txt", "gone.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(
      gitOutput(repo, ["show", "--name-status", "--format=", "HEAD"]).split("\n"),
      ["M\ta.txt", "D\tgone.txt"],
    );
    assert.equal(gitOutput(repo, ["status", "--short"]), "");
  } finally {
    cleanup(repo);
  }
});

test("--paths naming a directory in a sparse checkout stages its in-cone change", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "dir/in/a.txt", "one\n");
    commitFile(repo, "dir/out/b.txt", "one\n");
    runGit(repo, ["sparse-checkout", "set", "dir/in"]);
    writeFile(repo, "dir/in/a.txt", "two\n");

    const { result } = land(repo, ["--no-push", "--paths", "dir"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]), "dir/in/a.txt");
  } finally {
    cleanup(repo);
  }
});

test("--paths naming a file outside the sparse cone still stages the in-cone file", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "dir/in/a.txt", "one\n");
    commitFile(repo, "dir/out/b.txt", "one\n");
    runGit(repo, ["sparse-checkout", "set", "dir/in"]);
    writeFile(repo, "dir/in/a.txt", "two\n");

    const { result } = land(repo, ["--no-push", "--paths", "dir/in/a.txt", "dir/out/b.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]), "dir/in/a.txt");
  } finally {
    cleanup(repo);
  }
});

const isRoot = process.getuid?.() === 0;

test("a file git cannot stage is HOOK_FAILED instead of a partial commit", { skip: isRoot }, () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    const unreadablePath = writeFile(repo, "unreadable.txt", "secret\n");
    fs.chmodSync(unreadablePath, 0o000);
    const head = gitOutput(repo, ["rev-parse", "HEAD"]);

    const { code, result } = land(repo, ["--no-push"], VALID_MESSAGE);

    fs.chmodSync(unreadablePath, 0o644);
    assert.equal(result.outcome, "HOOK_FAILED");
    assert.equal(code, 21);
    assert.match((result.warnings as string[]).join("\n"), /could not stage changes: .*unreadable\.txt/);
    assert.equal(gitOutput(repo, ["rev-parse", "HEAD"]), head);
  } finally {
    cleanup(repo);
  }
});

test("--paths matching nothing dirty is NOTHING_TO_COMMIT", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    commitFile(repo, "b.txt", "one\n");
    writeFile(repo, "b.txt", "two\n");
    writeFile(repo, ".coherence/decisions/review-lane.jsonl", "{}\n");

    const { result } = land(repo, ["--no-push", "--paths", "a.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "NOTHING_TO_COMMIT");
  } finally {
    cleanup(repo);
  }
});

test("a push advances the origin ref and reports pushed", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    writeFile(repo, "a.txt", "two\n");

    const { result } = land(repo, [], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, true);
    const branch = gitOutput(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(gitOutput(origin, ["rev-parse", branch]), result.commit);
  } finally {
    cleanup(origin, repo);
  }
});

test("a feature push follows its upstream remote and ref when origin rejects pushes", () => {
  const origin = makeBareOrigin();
  const upstream = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/local-feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "upstream", upstream]);
    runGit(repo, ["push", "-q", "-u", "upstream", "HEAD:refs/heads/fast-stop-hook"]);
    writeOriginHook(origin, "pre-receive", "#!/bin/sh\nexit 1\n");
    writeFile(repo, "a.txt", "two\n");

    const { code, result } = land(repo, [], VALID_MESSAGE);

    assert.equal(code, 0);
    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, true);
    assert.equal(gitOutput(upstream, ["rev-parse", "refs/heads/fast-stop-hook"]), result.commit);
  } finally {
    cleanup(origin, upstream, repo);
  }
});

test("a feature branch tracking origin main pushes under its own name and leaves main alone", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);
    const originMainBefore = gitOutput(origin, ["rev-parse", "refs/heads/main"]);
    runGit(repo, ["checkout", "-q", "-b", "feature", "origin/main"]);
    writeFile(repo, "a.txt", "two\n");

    const { code, result } = land(repo, [], VALID_MESSAGE);

    assert.equal(code, 0);
    assert.equal(result.pushed, true);
    assert.equal(gitOutput(origin, ["rev-parse", "refs/heads/main"]), originMainBefore);
    assert.equal(gitOutput(origin, ["rev-parse", "refs/heads/feature"]), result.commit);
  } finally {
    cleanup(origin, repo);
  }
});

test("a repo with no origin commits and warns instead of pushing", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");

    const { result } = land(repo, [], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.equal(result.pushed, false);
    assert.match((result.warnings as string[]).join("\n"), /no origin remote configured/);
  } finally {
    cleanup(repo);
  }
});

test("a rejected push is PUSH_FAILED with the commit already made", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  const other = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    const branch = gitOutput(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    runGit(other, ["fetch", "-q", "origin"]);
    runGit(other, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
    commitFile(other, "a.txt", "someone else\n", "other change");
    runGit(other, ["push", "-q", "origin", branch]);

    writeFile(repo, "a.txt", "two\n");
    const { code, result } = land(repo, [], VALID_MESSAGE);

    assert.equal(result.outcome, "PUSH_FAILED");
    assert.equal(code, 22);
    assert.equal(result.pushed, false);
    assert.equal(result.commit, gitOutput(repo, ["rev-parse", "HEAD"]));
  } finally {
    cleanup(origin, repo, other);
  }
});

test("a pre-push hook refusal is not retried and its output lands in the warning", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    writeFile(repo, "a.txt", "two\n");
    writeFailingHook(repo, "pre-push");

    const { code, result } = land(repo, [], VALID_MESSAGE);

    assert.equal(result.outcome, "PUSH_FAILED");
    assert.equal(code, 22);
    const warnings = (result.warnings as string[]).join("\n");
    assert.doesNotMatch(warnings, /attempt/);
    assert.match(warnings, /refused before reaching origin, not retried/);
    assert.match(warnings, /check output: gate failed/);
    assert.match(warnings, /hook says no/);
  } finally {
    cleanup(origin, repo);
  }
});

function parkedBranchesIn(ledgerPath: string): string[] {
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { branch: string }).branch);
}

test("a clean rerun without --promote retries a failed push and clears the parked branch", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  const { ledgerDirectory, ledgerPath } = makeLedgerPath();
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    writeFile(repo, "a.txt", "two\n");
    writeFailingHook(repo, "pre-push");
    const ledgerEnv = { CLAUDE_COMMIT_LEDGER: ledgerPath };

    const failedLanding = land(repo, [], VALID_MESSAGE, ledgerEnv);
    assert.equal(failedLanding.result.outcome, "PUSH_FAILED");
    assert.deepEqual(parkedBranchesIn(ledgerPath), ["feature"]);

    fs.rmSync(path.join(repo, ".git", "hooks", "pre-push"));
    const rerun = land(repo, [], VALID_MESSAGE, ledgerEnv);

    assert.equal(rerun.result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(rerun.result.pushed, true);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), gitOutput(repo, ["rev-parse", "HEAD"]));
    assert.deepEqual(parkedBranchesIn(ledgerPath), []);
  } finally {
    cleanup(origin, repo, ledgerDirectory);
  }
});

test("a clean rerun without --promote on an already pushed branch pushes nothing", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    writeFailingHook(repo, "pre-push");

    const { result } = land(repo, [], VALID_MESSAGE);

    assert.equal(result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(result.pushed, true);
  } finally {
    cleanup(origin, repo);
  }
});

test("a clean rerun with --no-push leaves an unpushed branch alone", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    commitFile(repo, "a.txt", "two\n", "local only");

    const { result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(result.pushed, false);
    assert.notEqual(gitOutput(origin, ["rev-parse", "feature"]), gitOutput(repo, ["rev-parse", "HEAD"]));
  } finally {
    cleanup(origin, repo);
  }
});

test("a mainline sync pushes git's clean merge and a stack-after-squash merge that kept the side already holding the other's version, but withholds a hand-edited merge until stamp.ts clear records its review", () => {
  const origin = makeBareOrigin();
  const repo = cloneRepo(origin);
  const reviewGatesEnv = { REVIEW_GATES_DIR: reviewGatesDirectory(repo) };
  try {
    runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    commitFile(repo, "a.txt", "base\n");
    commitFile(repo, "b.txt", "base\n");
    runGit(repo, ["push", "-q", "-u", "origin", "main"]);
    runGit(repo, ["switch", "-q", "-c", "feature"]);
    commitFile(repo, "b.txt", "feature\n", "feature work");
    runGit(repo, ["push", "-q", "-u", "origin", "feature"]);
    const advanceMainline = (file: string, content: string) => {
      runGit(repo, ["switch", "-q", "main"]);
      commitFile(repo, file, content, `mainline ${file}`);
      runGit(repo, ["push", "-q", "origin", "main"]);
      runGit(repo, ["switch", "-q", "feature"]);
    };

    advanceMainline("a.txt", "mainline\n");
    runGit(repo, ["merge", "-q", "--no-edit", "origin/main"]);
    const cleanSync = landUnstamped(repo, [], "", reviewGatesEnv);
    assert.equal(cleanSync.result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(cleanSync.result.pushed, true);
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), gitOutput(repo, ["rev-parse", "HEAD"]));

    advanceMainline("b.txt", "mainline\n");
    assert.notEqual(tryGit(repo, ["merge", "-q", "--no-edit", "origin/main"]), 0);
    writeFile(repo, "b.txt", "resolved by hand\n");
    runGit(repo, ["add", "b.txt"]);
    runGit(repo, ["commit", "-q", "--no-edit"]);
    const resolvedMerge = gitOutput(repo, ["rev-parse", "HEAD"]);
    const withheldSync = landUnstamped(repo, [], "", reviewGatesEnv);
    assert.equal(withheldSync.result.outcome, "PUSH_WITHHELD");
    assert.equal(withheldSync.result.pushed, false);
    assert.deepEqual(withheldSync.result.next, { action: "runGate", gate: "gating-reviews", then: "landing", commits: [resolvedMerge.slice(0, 12)] });
    assert.notEqual(gitOutput(origin, ["rev-parse", "feature"]), resolvedMerge);

    const clear = spawnSync("node", [path.join(SKILL_DIR, "stamp.ts"), "clear"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...reviewGatesEnv } });
    assert.equal(clear.status, 0, clear.stderr ?? "");
    const reviewedSync = landUnstamped(repo, [], "", reviewGatesEnv);
    assert.equal(reviewedSync.result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), resolvedMerge);

    runGit(repo, ["switch", "-q", "-c", "lower", "origin/main"]);
    commitFile(repo, "stacked.txt", "lower\n", "lower work");
    runGit(repo, ["push", "-q", "origin", "lower"]);
    runGit(repo, ["switch", "-q", "feature"]);
    runGit(repo, ["merge", "-q", "--no-edit", "origin/lower"]);
    commitFile(repo, "stacked.txt", "lower\ntop\n", "top work");
    const stackRecorded = spawnSync("node", [path.join(SKILL_DIR, "stamp.ts"), "clear"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...reviewGatesEnv } });
    assert.equal(stackRecorded.status, 0, stackRecorded.stderr ?? "");
    assert.equal(landUnstamped(repo, [], "", reviewGatesEnv).result.pushed, true);
    runGit(repo, ["switch", "-q", "main"]);
    runGit(repo, ["merge", "-q", "--squash", "origin/lower"]);
    runGit(repo, ["commit", "-q", "-m", "squash lower"]);
    runGit(repo, ["push", "-q", "origin", "main"]);
    runGit(repo, ["switch", "-q", "feature"]);
    assert.notEqual(tryGit(repo, ["merge", "-q", "--no-edit", "origin/main"]), 0);
    runGit(repo, ["checkout", "--ours", "stacked.txt"]);
    runGit(repo, ["add", "stacked.txt"]);
    runGit(repo, ["commit", "-q", "--no-edit"]);
    const stackSync = landUnstamped(repo, [], "", reviewGatesEnv);
    assert.equal(stackSync.result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), gitOutput(repo, ["rev-parse", "HEAD"]));
  } finally {
    cleanup(origin, repo);
  }
});

test("a nested denylisted file is not staged through its parent directory", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "feature/index.ts", "export const x = 1;\n");
    writeFile(repo, "feature/.env.local", "SECRET=1\n");
    writeFile(repo, "feature/debug.log", "noise\n");

    const { result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), [
      "feature/index.ts",
    ]);
    assert.match(gitOutput(repo, ["status", "--short"]), /feature\/\.env\.local/);
  } finally {
    cleanup(repo);
  }
});

test("a file staged outside the stamped paths is unstaged and excluded from the commit", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    commitFile(repo, "b.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, "b.txt", "someone else staged this\n");
    runGit(repo, ["add", "--", "b.txt"]);

    const { result } = land(repo, ["--no-push", "--paths", "a.txt"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.match((result.warnings as string[]).join("\n"), /excluded staged files outside the stamped paths.*b\.txt/);
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), [
      "a.txt",
    ]);
    assert.deepEqual(gitOutput(repo, ["diff", "--name-only"]), "b.txt");
  } finally {
    cleanup(repo);
  }
});

test("a staged denylisted addition stops the run instead of riding along", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, "a.txt", "one\n");
    writeFile(repo, "a.txt", "two\n");
    writeFile(repo, ".env", "AWS_SECRET_ACCESS_KEY=real\n");
    runGit(repo, ["add", "-f", "--", ".env"]);
    const head = gitOutput(repo, ["rev-parse", "HEAD"]);

    const { code, result } = land(
      repo,
      ["--no-push", "--paths", "a.txt", ".env"],
      VALID_MESSAGE,
    );

    assert.equal(result.outcome, "DENYLISTED_FILE_STAGED");
    assert.equal(code, 25);
    assert.deepEqual(result.files, [".env"]);
    assert.equal(gitOutput(repo, ["rev-parse", "HEAD"]), head);
  } finally {
    cleanup(repo);
  }
});

test("a local path in a staged line or the message stops the run before it reaches history", () => {
  const repo = makeRepo("feature");
  const [listedUsername] = listedUsernames();
  try {
    commitFile(repo, "config.py", `SITE_ROOT = '${os.homedir()}/site'\n`);
    writeFile(
      repo,
      "config.py",
      [
        `SITE_ROOT = '${os.homedir()}/site'`,
        `MONOREPO_ROOT = '${os.homedir()}/projects/posthog'`,
        `POSTHOG_JS_ROOT = '/Users/${listedUsername}/projects/posthog-js'`,
        `CURRENT_USER_ROOT = '/home/${os.userInfo().username}/src'`,
        "",
      ].join("\n"),
    );
    writeFile(repo, "notes.txt", `${os.homedir()}x, ${os.homedir()}.bak and /home/user/ are not local paths\n`);
    const head = gitOutput(repo, ["rev-parse", "HEAD"]);
    const messageWithLocalPath = VALID_MESSAGE.replace("A body line.", `Moved off ${os.homedir()}/site.\nStopped reading /Users/${listedUsername}.`);

    const { code, result } = land(repo, ["--no-push"], messageWithLocalPath);

    assert.equal(result.outcome, "HOME_PATH_STAGED");
    assert.equal(code, 30);
    assert.deepEqual(result.matches, ["config.py:2", "config.py:3", "config.py:4", "commit message:3", "commit message:4"]);
    assert.equal(gitOutput(repo, ["rev-parse", "HEAD"]), head);
  } finally {
    cleanup(repo);
  }
});

test("the gate refuses additions only, so a tracked denylisted file stays editable", () => {
  const repo = makeRepo("feature");
  try {
    commitFile(repo, ".env.example", "TOKEN=replace-me\n");
    writeFile(repo, ".env.example", "TOKEN=replace-me\nREGION=us-east-1\n");

    const { result } = land(repo, ["--no-push"], VALID_MESSAGE);

    assert.equal(result.outcome, "COMMITTED");
    assert.deepEqual(gitOutput(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), [
      ".env.example",
    ]);
  } finally {
    cleanup(repo);
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

test("a spec lands live: refused unreviewed, ticket commits scoped to the stamp, stale stamp refused, intent promoted once, release stamped by --only, and an unlanded commit withheld", () => {
  const { origin, seed, local } = seedOrigin();
  const ticketMessage = (ticketId: string) => `${VALID_MESSAGE}\nTicket: live-spec/${ticketId}\n`;
  const writeReleaseStamp = (paths: string[]) =>
    spawnSync("node", [path.join(SKILL_DIR, "stamp.ts"), "write", "--gate", "releasing", "--only", ...paths], {
      cwd: local,
      encoding: "utf8",
      env: { ...process.env, REVIEW_GATES_DIR: reviewGatesDirectory(local) },
    });
  try {
    const mainBeforeSpec = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "ticket.txt", "first ticket\n");
    writeFile(local, "stray.txt", "never reviewed\n");
    assert.equal(landUnstamped(local, [], ticketMessage("U1")).result.outcome, "NOT_REVIEWED");

    assert.equal(stamp(local, ["ticket.txt"]).code, 0);
    const firstTicket = landUnstamped(local, [], ticketMessage("U1"));
    assert.equal(firstTicket.result.outcome, "COMMITTED");
    assert.deepEqual(firstTicket.result.next, { action: "done" });
    assert.deepEqual(gitOutput(local, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), ["ticket.txt"]);
    assert.equal(gitOutput(local, ["log", "-1", "--format=%(trailers:key=Ticket,valueonly)"]), "live-spec/U1");
    assert.equal(gitOutput(origin, ["rev-parse", "feature"]), firstTicket.result.commit);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainBeforeSpec);

    writeFile(local, "ticket.txt", "first ticket\nsecond ticket\n");
    assert.equal(stamp(local, ["ticket.txt"]).code, 0);
    writeFile(local, "ticket.txt", "first ticket\nsecond ticket, edited after review\n");
    assert.equal(landUnstamped(local, [], ticketMessage("U2")).result.outcome, "NOT_REVIEWED");
    assert.equal(stamp(local, ["ticket.txt"]).code, 0);
    assert.equal(landUnstamped(local, [], ticketMessage("U2")).result.outcome, "COMMITTED");
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainBeforeSpec);

    const intentLanding = landUnstamped(local, ["--promote"], VALID_MESSAGE);
    assert.equal(intentLanding.result.outcome, "NOTHING_TO_COMMIT");
    assert.equal(gitOutput(origin, ["show", "main:ticket.txt"]), "first ticket\nsecond ticket, edited after review");
    assert.equal(gitOutput(origin, ["rev-list", "--count", `${mainBeforeSpec}..main`]), "2");

    writeFile(local, "VERSION", "1.1.0\n");
    assert.equal(writeReleaseStamp(["VERSION"]).status, 2);
    fs.rmSync(path.join(local, "stray.txt"));
    assert.equal(writeReleaseStamp(["VERSION"]).status, 0);
    assert.equal(landUnstamped(local, ["--promote"], "chore(release): 1.1.0\n").result.outcome, "COMMITTED");
    assert.equal(gitOutput(origin, ["show", "main:VERSION"]), "1.1.0");

    const mainBeforeHandCommit = gitOutput(origin, ["rev-parse", "main"]);
    writeFile(local, "ticket.txt", "committed by hand\n");
    runGit(local, ["commit", "-qam", "by hand"]);
    const withheld = landUnstamped(local, ["--promote"], VALID_MESSAGE);
    assert.equal(withheld.result.outcome, "PROMOTE_WITHHELD");
    assert.match((withheld.result.findings as string[]).join("\n"), /^UNREVIEWED [0-9a-f]{12}: not landed through land\.ts$/);
    assert.equal(gitOutput(origin, ["rev-parse", "main"]), mainBeforeHandCommit);
  } finally {
    cleanup(origin, seed, local);
  }
});

test("two checkouts sharing a folder name keep separate stamp ledgers", (context) => {
  const firstParent = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-a-"));
  const secondParent = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-b-"));
  const gatesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-gates-"));
  const previousGatesDirectory = process.env.REVIEW_GATES_DIR;
  process.env.REVIEW_GATES_DIR = gatesDirectory;
  context.after(() => {
    restoreGatesDirectory(previousGatesDirectory);
    cleanup(firstParent, secondParent, gatesDirectory);
  });
  const [firstRepo, secondRepo] = [firstParent, secondParent].map((parent) => {
    const repo = path.join(parent, "app");
    fs.mkdirSync(repo);
    runGit(repo, ["init", "-q", "-b", "main"]);
    return repo;
  });

  assert.notEqual(stampLedgerPath(new Git(secondRepo)), stampLedgerPath(new Git(firstRepo)));
});

function restoreGatesDirectory(previousGatesDirectory: string | undefined): void {
  if (previousGatesDirectory === undefined) {
    delete process.env.REVIEW_GATES_DIR;
    return;
  }
  process.env.REVIEW_GATES_DIR = previousGatesDirectory;
}

test("a review gate refuses to stamp an untracked browser-code failure in an owned repo or when gh cannot tell, records it for another org's repo, and only notes a live CSP miss", (context) => {
  const repo = makeRepo();
  const ghStubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-gh-"));
  const previousPath = process.env.PATH;
  context.after(() => {
    process.env.PATH = previousPath;
    cleanup(repo, ghStubDirectory);
  });
  commitFile(repo, "base.txt", "base\n", "init");
  writeFile(repo, "package.json", JSON.stringify({ dependencies: { "posthog-js": "^1.400.0" } }));
  writeFile(repo, ".browser-sdk-sites.json", JSON.stringify(["http://127.0.0.1:9/"]));

  const ownedRefusal = stamp(repo, ["package.json"]);
  assert.equal(ownedRefusal.code, 30, ownedRefusal.stderr);
  assert.match(ownedRefusal.stderr, /^FAIL exact-pin package\.json posthog-js uses "\^1\.400\.0".*Fix: /m);
  assert.equal(fs.existsSync(stampLedgerPath(new Git(repo))), false);

  runGit(repo, ["remote", "add", "origin", "git@github.com:Example/widget.git"]);
  process.env.PATH = `${ghStubDirectory}${path.delimiter}${previousPath ?? ""}`;
  writeExecutable(path.join(ghStubDirectory, "gh"), "#!/bin/sh\necho 'error connecting to api.github.com' >&2\nexit 1\n");
  assert.equal(stamp(repo, ["package.json"]).code, 30);

  writeExecutable(path.join(ghStubDirectory, "gh"), "#!/bin/sh\necho someone-else\n");
  const orgStamp = stamp(repo, ["package.json"]);
  assert.equal(orgStamp.code, 0, orgStamp.stderr);
  assert.match((orgStamp.result.preexistingFailures as string[]).join("\n"), /^browser-code: FAIL exact-pin package\.json/m);
  assert.doesNotMatch((orgStamp.result.preexistingFailures as string[]).join("\n"), /live-csp/);

  runGit(repo, ["remote", "remove", "origin"]);
  writeFile(repo, "package.json", JSON.stringify({ dependencies: { "posthog-js": "1.400.0" } }));
  writeFile(repo, "package-lock.json", "{}");
  writeFile(repo, "netlify.toml", `[build]\n  command = "npm ci"\n[[headers]]\n  for = "/*"\n  [headers.values]\n    Content-Security-Policy = "script-src 'self'"\n`);
  const ownedLiveNoteStamp = stamp(repo, ["package.json", "package-lock.json", "netlify.toml", ".browser-sdk-sites.json"]);
  assert.equal(ownedLiveNoteStamp.code, 0, ownedLiveNoteStamp.stderr);
  assert.match((ownedLiveNoteStamp.result.preexistingFailures as string[]).join("\n"), /^browser-code: NOTE live-csp http:\/\/127\.0\.0\.1:9\/ could not be reached \(refused the private address 127\.0\.0\.1\)/m);
});
