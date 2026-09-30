import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { githubRepositoryName } from "../lib/visibility.ts";
import { cleanup, commitFile, makeRepo, preflight, runGit, writeExecutable } from "./helpers.ts";

function preflightWithStubbedGh(ghBody: string): Record<string, unknown> {
  const repo = makeRepo();
  const stubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-gh-"));
  try {
    commitFile(repo, "a.txt", "one\n");
    runGit(repo, ["remote", "add", "origin", "git@github.com:Example/widget.git"]);
    writeExecutable(path.join(stubDirectory, "gh"), ghBody);
    const pathWithStub = `${stubDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
    return preflight(repo, ["--no-fetch"], { PATH: pathWithStub }).result;
  } finally {
    cleanup(repo, stubDirectory);
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

test("preflight reports a GitHub origin's visibility from gh", () => {
  const result = preflightWithStubbedGh(
    '#!/bin/sh\n[ "$3" = github.com/Example/widget ] || { echo "unexpected repo $3" >&2; exit 1; }\necho PUBLIC\n',
  );
  assert.deepEqual(result.remoteVisibility, { remote: "origin", visibility: "public" });
});

test("preflight reports unknown visibility when gh fails", () => {
  const result = preflightWithStubbedGh('#!/bin/sh\necho "HTTP 404" >&2\nexit 1\n');
  const remoteVisibility = result.remoteVisibility as Record<string, string>;
  assert.equal(remoteVisibility.visibility, "unknown");
  assert.match(remoteVisibility.reason ?? "", /HTTP 404/);
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
