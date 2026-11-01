import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  cloneRepo,
  commitFile,
  gitOutput,
  makeBareOrigin,
  runGit,
  writeFile,
} from "../../landing/test/helpers.ts";

const PUBLISH_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "publish.ts");

const RELEASE_PROFILE = {
  git: { release_from: "main", integration: "develop" },
  versioning: { tag_format: "vX.Y.Z" },
};

type ReleaseFixture = { origin: string; local: string; releaseCommit: string };

function makeReleaseFixture(): ReleaseFixture {
  const origin = makeBareOrigin();
  const local = cloneRepo(origin);
  runGit(local, ["checkout", "-q", "-b", "main"]);
  commitFile(local, "base.txt", "base\n", "init");
  runGit(local, ["branch", "develop"]);
  runGit(local, ["push", "-q", "origin", "main", "develop"]);
  commitFile(local, "version.txt", "0.7.0\n", "chore(release): v0.7.0");
  runGit(local, ["push", "-q", "origin", "main"]);
  runGit(local, ["checkout", "-q", "develop"]);
  runGit(local, ["merge", "-q", "--ff-only", "main"]);
  runGit(local, ["tag", "-a", "v0.7.0", "-m", "v0.7.0", "main"]);
  writeFile(local, ".claude/release-profile.json", JSON.stringify(RELEASE_PROFILE));
  return { origin, local, releaseCommit: gitOutput(local, ["rev-parse", "main"]) };
}

function runPublish(repo: string, args: string[]): { code: number; result: Record<string, unknown> } {
  const proc = spawnSync("node", [PUBLISH_SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { code: proc.status ?? 1, result: JSON.parse(proc.stdout.trim().split("\n").at(-1) ?? "{}") };
}

function remoteRefs(origin: string): string {
  return gitOutput(origin, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}

function withFixture(body: (fixture: ReleaseFixture) => void): void {
  const fixture = makeReleaseFixture();
  try {
    body(fixture);
  } finally {
    cleanup(fixture.origin, path.dirname(fixture.local));
  }
}

test("publish fast-forwards the integration branch and pushes the tag, and a rerun is up to date", () => {
  withFixture(({ origin, local, releaseCommit }) => {
    const firstRun = runPublish(local, ["--tag", "v0.7.0", "--branch", "develop"]);
    assert.equal(firstRun.result.outcome, "PUBLISHED");
    assert.equal(firstRun.code, 0);
    assert.equal(gitOutput(origin, ["rev-parse", "refs/heads/develop"]), releaseCommit);
    assert.equal(gitOutput(origin, ["rev-parse", "refs/tags/v0.7.0^{commit}"]), releaseCommit);

    const rerun = runPublish(local, ["--tag", "v0.7.0", "--branch", "develop"]);
    assert.equal(rerun.result.outcome, "PUBLISHED");
    assert.equal(rerun.code, 0);
    const rerunStatuses = Object.values(rerun.result.refs as Record<string, { status: string }>).map((ref) => ref.status);
    assert.deepEqual(rerunStatuses, ["up_to_date", "up_to_date"]);
  });
});

test("publish pushes only the requested refs when push.followTags is set", () => {
  withFixture(({ origin, local }) => {
    runGit(local, ["tag", "-a", "internal-note", "-m", "internal note", "main~1"]);
    runGit(local, ["config", "push.followTags", "true"]);
    const run = runPublish(local, ["--tag", "v0.7.0", "--branch", "develop"]);
    assert.equal(run.result.outcome, "PUBLISHED");
    assert.equal(gitOutput(origin, ["tag", "-l"]), "v0.7.0");
  });
});

const REFUSALS:Array<{ name: string; outcome: string; arrange: (fixture: ReleaseFixture) => string[] }> = [
  {
    name: "a non-fast-forward branch",
    outcome: "PUSH_REJECTED",
    arrange: ({ origin }) => {
      const otherClone = cloneRepo(origin);
      runGit(otherClone, ["checkout", "-q", "develop"]);
      commitFile(otherClone, "other.txt", "other\n", "feat: diverge");
      runGit(otherClone, ["push", "-q", "origin", "develop"]);
      cleanup(path.dirname(otherClone));
      return ["--tag", "v0.7.0", "--branch", "develop"];
    },
  },
  {
    name: "a branch the profile does not name",
    outcome: "BRANCH_NOT_ALLOWED",
    arrange: ({ local }) => {
      runGit(local, ["branch", "feature"]);
      return ["--tag", "v0.7.0", "--branch", "feature"];
    },
  },
  {
    name: "a lightweight tag",
    outcome: "TAG_INVALID",
    arrange: ({ local }) => {
      runGit(local, ["tag", "-d", "v0.7.0"]);
      runGit(local, ["tag", "v0.7.0", "main"]);
      return ["--tag", "v0.7.0", "--branch", "develop"];
    },
  },
  {
    name: "a different tag already on the remote",
    outcome: "PUSH_REJECTED",
    arrange: ({ origin }) => {
      const otherClone = cloneRepo(origin);
      runGit(otherClone, ["tag", "-a", "v0.7.0", "-m", "someone else's v0.7.0", "origin/main"]);
      runGit(otherClone, ["push", "-q", "origin", "refs/tags/v0.7.0"]);
      cleanup(path.dirname(otherClone));
      return ["--tag", "v0.7.0", "--branch", "develop"];
    },
  },
  {
    name: "a tag not on the release_from tip",
    outcome: "TAG_NOT_ON_RELEASE_TIP",
    arrange: ({ local }) => {
      runGit(local, ["tag", "-a", "v0.6.9", "-m", "v0.6.9", "main~1"]);
      return ["--tag", "v0.6.9", "--branch", "develop"];
    },
  },
  {
    name: "a tag only on a remote branch whose name ends in the release_from ref",
    outcome: "TAG_NOT_ON_RELEASE_TIP",
    arrange: ({ origin, local }) => {
      runGit(local, ["push", "-q", "origin", "v0.7.0^{commit}:refs/heads/a/refs/heads/main"]);
      const otherClone = cloneRepo(origin);
      runGit(otherClone, ["checkout", "-q", "main"]);
      commitFile(otherClone, "other.txt", "other\n", "feat: advance main");
      runGit(otherClone, ["push", "-q", "origin", "main"]);
      cleanup(path.dirname(otherClone));
      return ["--tag", "v0.7.0"];
    },
  },
  {
    name: "a name not matching tag_format",
    outcome: "TAG_INVALID",
    arrange: ({ local }) => {
      runGit(local, ["tag", "-a", "release-0.7.0", "-m", "release-0.7.0", "main"]);
      return ["--tag", "release-0.7.0", "--branch", "develop"];
    },
  },
];

for (const refusal of REFUSALS) {
  test(`publish refuses ${refusal.name} and leaves the remote unchanged`, () => {
    withFixture((fixture) => {
      const args = refusal.arrange(fixture);
      const refsBeforeRun = remoteRefs(fixture.origin);
      const run = runPublish(fixture.local, args);
      assert.equal(run.result.outcome, refusal.outcome);
      assert.notEqual(run.code, 0);
      assert.equal(remoteRefs(fixture.origin), refsBeforeRun);
    });
  });
}
