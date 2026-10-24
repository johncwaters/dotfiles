import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { githubRepositoryName } from "../lib/visibility.ts";
import { cleanup, commitFile, makePolicyRoot, makeRepo, preflight, runGit, writeExecutable } from "./helpers.ts";

function preflightWithStubbedGh(ghBody: string): Record<string, unknown> {
  const repo = makeRepo();
  const stubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-gh-"));
  const policyRoot = makePolicyRoot("work", { mainline: "auto" });
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", "git@github.com:Example/widget.git"]);
    writeExecutable(path.join(stubDirectory, "gh"), ghBody);
    const pathWithStub = `${stubDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
    return preflight(repo, ["--no-fetch"], { PATH: pathWithStub, CLAUDE_COMMIT_POLICY_ROOT: policyRoot }).result;
  } finally {
    cleanup(repo, stubDirectory, policyRoot);
  }
}

test("GitHub remote urls resolve to owner/name in every clone form", () => {
  assert.equal(githubRepositoryName("git@github.com:PostHog/posthog.git"), "PostHog/posthog");
  assert.equal(githubRepositoryName("https://github.com/PostHog/posthog"), "PostHog/posthog");
  assert.equal(githubRepositoryName("https://github.com/PostHog/posthog.git\n"), "PostHog/posthog");
  assert.equal(githubRepositoryName("ssh://git@github.com/PostHog/posthog.git"), "PostHog/posthog");
  assert.equal(githubRepositoryName("https://gitlab.com/PostHog/posthog.git"), null);
  assert.equal(githubRepositoryName("/tmp/origin.git"), null);
});

function ownedOriginGhStub(isFork: boolean, resolvedOwner = "Example"): string {
  return `#!/bin/sh\n[ "$1" != api ] || { echo eXaMpLe; exit 0; }\n[ "$3" = github.com/Example/widget ] || { echo "unexpected repo $3" >&2; exit 1; }\n[ "$5" != isFork,owner ] || { printf '%s\\t%s\\n' ${resolvedOwner} ${isFork}; exit 0; }\necho PUBLIC\n`;
}

test("preflight reports a GitHub origin's visibility from gh", () => {
  const result = preflightWithStubbedGh(ownedOriginGhStub(false));
  assert.deepEqual(result.remoteVisibility, { remote: "origin", visibility: "public" });
  assert.equal((result.policy as Record<string, unknown>).afterCommit, "promote");
});

test("preflight leaves a fork or a repo gh resolves to another owner for a pull request", () => {
  const fork = preflightWithStubbedGh(ownedOriginGhStub(true));
  assert.equal((fork.policy as Record<string, unknown>).afterCommit, "pull-request");
  const transferred = preflightWithStubbedGh(ownedOriginGhStub(false, "SomeOrg"));
  assert.equal((transferred.policy as Record<string, unknown>).afterCommit, "pull-request");
});

test("preflight reports unknown visibility when gh fails", () => {
  const result = preflightWithStubbedGh('#!/bin/sh\necho "HTTP 404" >&2\nexit 1\n');
  const remoteVisibility = result.remoteVisibility as Record<string, string>;
  assert.equal(remoteVisibility.visibility, "unknown");
  assert.match(remoteVisibility.reason ?? "", /HTTP 404/);
  assert.equal((result.policy as Record<string, unknown>).afterCommit, "pull-request");
  assert.match((result.warnings as string[]).join("\n"), /gh api user --jq \.login failed: HTTP 404/);
});

test("preflight promotes a local-only repo but leaves a non-GitHub origin for a pull request", () => {
  const repo = makeRepo();
  const policyRoot = makePolicyRoot("personal", { mainline: "auto" });
  try {
    commitFile(repo, "a.txt", "one\n");
    const environment = { CLAUDE_COMMIT_POLICY_ROOT: policyRoot };
    const localOnly = preflight(repo, ["--no-fetch"], environment).result;
    assert.equal((localOnly.policy as Record<string, unknown>).afterCommit, "promote");
    assert.equal(localOnly.warnings, undefined);

    runGit(repo, ["remote", "add", "origin", "https://gitlab.com/Example/widget.git"]);
    const nonGithub = preflight(repo, ["--no-fetch"], environment).result;
    assert.equal((nonGithub.policy as Record<string, unknown>).afterCommit, "pull-request");
    assert.match((nonGithub.warnings as string[]).join("\n"), /origin is not a GitHub remote/);
  } finally {
    cleanup(repo, policyRoot);
  }
});

test("preflight reports unknown visibility without an origin remote", () => {
  const repo = makeRepo();
  try {
    commitFile(repo, "a.txt", "one\n");
    const { result } = preflight(repo, ["--no-fetch"]);
    assert.deepEqual(result.remoteVisibility, {
      remote: "origin",
      visibility: "unknown",
      reason: "no origin remote",
    });
  } finally {
    cleanup(repo);
  }
});
