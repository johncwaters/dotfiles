import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CHECK_SCRIPT = path.join(import.meta.dirname, "..", "check.ts");
const ENVIRONMENT_WITHOUT_REPOSITORY_OVERRIDES = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function createRepo(filesByPath: Record<string, string>): string {
  const repoDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "securing-browser-code-"));
  for (const [relativePath, contents] of Object.entries(filesByPath)) {
    fs.mkdirSync(path.dirname(path.join(repoDirectory, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(repoDirectory, relativePath), contents);
  }
  spawnSync("git", ["init", "-q"], { cwd: repoDirectory, env: ENVIRONMENT_WITHOUT_REPOSITORY_OVERRIDES });
  spawnSync("git", ["add", "-A"], { cwd: repoDirectory, env: ENVIRONMENT_WITHOUT_REPOSITORY_OVERRIDES });
  return repoDirectory;
}

function runCheck(repoDirectory: string): { exitCode: number | null; output: string } {
  const run = spawnSync(process.execPath, [CHECK_SCRIPT, repoDirectory], { encoding: "utf8" });
  return { exitCode: run.status, output: run.stdout + run.stderr };
}

test("a repo with no browser SDK and no cross-origin script is skipped", () => {
  const repoDirectory = createRepo({ "package.json": JSON.stringify({ dependencies: { "posthog-node": "^5.0.0" } }) });
  const { exitCode, output } = runCheck(repoDirectory);
  assert.equal(exitCode, 0, output);
  assert.match(output, /skipped: no third-party browser code/);
});

test("a browser SDK repo fails each unmet practice, and a reasoned waiver clears its match", () => {
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-js": "^1.400.0", astro: "5.1.0" } }),
    "examples/demo/package.json": JSON.stringify({ dependencies: { "posthog-js": "~1.400.0" } }),
    "examples/demo/package-lock.json": "{}",
    "examples/demo/pnpm-lock.yaml": "",
    ".github/workflows/ci.yml": "steps:\n  - run: npm install\n  - run: npm install -g vercel\n",
    ".browser-sdk-waivers.json": JSON.stringify([
      { check: "exact-pin", paths: "examples/**", reason: "docs samples track the latest minor" },
      { check: "lockfile", paths: "package.json" },
    ]),
  });
  const { exitCode, output } = runCheck(repoDirectory);
  assert.equal(exitCode, 1, output);
  assert.match(output, /FAIL exact-pin package\.json posthog-js uses "\^1\.400\.0"/);
  assert.doesNotMatch(output, /FAIL exact-pin examples/);
  assert.doesNotMatch(output, /astro/);
  assert.match(output, /FAIL lockfile package\.json no committed lockfile covers it/);
  assert.match(output, /FAIL lockfile examples\/demo\/package\.json package-lock\.json and pnpm-lock\.yaml/);
  assert.match(output, /FAIL frozen-install \.github\/workflows\/ci\.yml:2 "npm install"/);
  assert.doesNotMatch(output, /ci\.yml:3/);
  assert.match(output, /FAIL waiver-reason \.browser-sdk-waivers\.json entry 2/);
});
