import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Git } from "../lib/git.ts";
import { cleanup, commitFile, makeRepo, REAL_GIT_PATH, runGit, writeExecutable } from "./helpers.ts";

const DRIVER_ENUMERATION_ARGUMENTS = [
  "config",
  "--name-only",
  "--get-regexp",
  "^merge\\..+\\.driver$",
].join(" ");

function withEnvironment<Value>(overrides: Record<string, string>, body: () => Value): Value {
  const restored = Object.keys(overrides).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, overrides);
  try {
    return body();
  } finally {
    for (const [name, previousValue] of restored) {
      if (previousValue === undefined) {
        delete process.env[name];
        continue;
      }
      process.env[name] = previousValue;
    }
  }
}

function gitWrapperReactingToDriverEnumeration(reaction: string[]): string {
  return [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    'import fs from "node:fs";',
    `if (process.argv.slice(2).join(" ") === ${JSON.stringify(DRIVER_ENUMERATION_ARGUMENTS)}) {`,
    ...reaction.map((line) => `  ${line}`),
    "}",
    `const forwarded = spawnSync(${JSON.stringify(REAL_GIT_PATH)}, process.argv.slice(2), { stdio: "inherit" });`,
    "process.exit(forwarded.status ?? 1);",
    "",
  ].join("\n");
}

function makeOursDriverRepo(): string {
  const repo = makeRepo();
  commitFile(repo, ".gitattributes", "* merge=ours\n", "attributes");
  commitFile(repo, "base.txt", "base\n", "base");
  runGit(repo, ["branch", "feature"]);
  commitFile(repo, "base.txt", "main side\n", "main side");
  runGit(repo, ["checkout", "-q", "feature"]);
  commitFile(repo, "base.txt", "feature side\n", "feature side");
  runGit(repo, ["checkout", "-q", "main"]);
  runGit(repo, ["config", "merge.ours.driver", "true"]);
  return repo;
}

test("a locally configured merge driver cannot force a contained merge-tree result", () => {
  const repo = makeOursDriverRepo();
  try {
    const mergeTree = new Git(repo).mergeTree("main", "feature");

    assert.notEqual(mergeTree.code, 0);
  } finally {
    cleanup(repo);
  }
});

test("a legacy GIT_CONFIG variable is stripped before merge-tree probes", () => {
  const repo = makeOursDriverRepo();
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-git-config-"));
  const markerPath = path.join(wrapperDirectory, "legacy-config-marker");
  try {
    writeExecutable(
      path.join(wrapperDirectory, "git"),
      gitWrapperReactingToDriverEnumeration([
        'fs.writeFileSync(process.env.CONFIG_MARKER ?? "", process.env.GIT_CONFIG ?? "absent");',
      ]),
    );

    withEnvironment(
      {
        GIT_CONFIG: "/tmp/legacy-config",
        PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        CONFIG_MARKER: markerPath,
      },
      () => new Git(repo).mergeTree("main", "feature"),
    );

    assert.equal(fs.readFileSync(markerPath, "utf8"), "absent");
  } finally {
    cleanup(repo, wrapperDirectory);
  }
});

test("a merge-driver enumeration error fails the containment probe", () => {
  const repo = makeOursDriverRepo();
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-git-wrapper-"));
  try {
    writeExecutable(
      path.join(wrapperDirectory, "git"),
      gitWrapperReactingToDriverEnumeration(["process.exit(2);"]),
    );

    const mergeTree = withEnvironment(
      { PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ""}` },
      () => new Git(repo).mergeTree("main", "feature"),
    );

    assert.notEqual(mergeTree.code, 0);
    assert.match(mergeTree.stderr, /could not enumerate configured merge drivers/);
  } finally {
    cleanup(repo, wrapperDirectory);
  }
});

test("an injected safe.directory never reaches the merge-tree child", () => {
  const repo = makeOursDriverRepo();
  try {
    const mergeTree = withEnvironment(
      {
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
        GIT_CONFIG_PARAMETERS: "'safe.directory=*'",
      },
      () => new Git(repo).mergeTree("main", "feature"),
    );

    assert.notEqual(mergeTree.code, 0);
    assert.match(mergeTree.stderr, /dubious ownership/);
  } finally {
    cleanup(repo);
  }
});

test("a global safe.directory carries into both probes for a foreign-owned repository", () => {
  const repo = makeOursDriverRepo();
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-safe-dir-"));
  const globalConfigPath = path.join(configDirectory, "gitconfig");
  try {
    fs.writeFileSync(globalConfigPath, `[safe]\n\tdirectory = ${repo}\n`, "utf8");

    const mergeTree = withEnvironment(
      {
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_CONFIG_SYSTEM: os.devNull,
      },
      () => new Git(repo).mergeTree("main", "feature"),
    );

    assert.equal(/dubious ownership/.test(mergeTree.stderr), false);
    assert.equal(/could not enumerate configured merge drivers/.test(mergeTree.stderr), false);
    assert.notEqual(mergeTree.code, 0);
  } finally {
    cleanup(repo, configDirectory);
  }
});
