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
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-node": "^5.0.0" } }),
    "test/snippet.test.ts": `t.createElement("script"); p.src=s.api_host+"/static/array.js"; <script src="https://cdn.example.com/x.js"></script>`,
  });
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
    "public/index.html": [
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'">`,
      `<script src="https://cdn.example.com/widget.js"></script>`,
      `<script src="https://cdn.example.com/pinned.js" integrity="sha384-abc" crossorigin="anonymous"></script>`,
    ].join("\n"),
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
  assert.match(output, /FAIL script-integrity public\/index\.html:2 cross-origin script lacks integrity and crossorigin/);
  assert.doesNotMatch(output, /index\.html:3/);
  assert.match(output, /FAIL csp-unsafe public\/index\.html:1 script-src grants 'unsafe-inline'/);
});

test("a PostHog snippet install with only a report-only policy fails integrity and CSP", () => {
  const repoDirectory = createRepo({
    "src/layout.html": [
      `<link rel="stylesheet" href="https://cdn.example.com/x.css" integrity="sha384-abc" crossorigin="anonymous">`,
      ...Array.from({ length: 60 }, () => "<p>filler paragraph that pushes the stylesheet out of the snippet's reach</p>"),
      `<script>!function(t,e){(p=t.createElement("script")).src=s.api_host+"/static/array.js"}(document,window.posthog||[]);</script>`,
    ].join("\n"),
    "_headers": "/*\n  Content-Security-Policy-Report-Only: script-src 'self'\n",
    "server/app.js": `app.use(helmet({ contentSecurityPolicy: { reportOnly: true, directives: { scriptSrc: ["'self'"] } } }));`,
    "docs/csp.mdx": "Configure a Content-Security-Policy header to allow PostHog.",
  });
  const { exitCode, output } = runCheck(repoDirectory);
  assert.equal(exitCode, 1, output);
  assert.match(output, /FAIL script-integrity src\/layout\.html:62 PostHog snippet loads its loader without subresource integrity/);
  assert.match(output, /FAIL csp-missing _headers:2 the Content-Security-Policy is report-only/);
});

test("a policy built in a variable is judged by its script-src, not by an earlier script-src-elem", () => {
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-js": "1.400.0" } }),
    "src/middleware.ts": [
      "const cspHeader = `default-src 'self'; script-src-elem 'self'; script-src 'self' 'unsafe-eval';`;",
      "response.headers.set('Content-Security-Policy', cspHeader);",
    ].join("\n"),
  });
  const { output } = runCheck(repoDirectory);
  assert.match(output, /FAIL csp-unsafe src\/middleware\.ts:2 script-src grants 'unsafe-eval'/);
});
