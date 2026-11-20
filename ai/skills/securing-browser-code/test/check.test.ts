import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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

function runCheck(repoDirectory: string, extraEnvironment: Record<string, string> = {}): { exitCode: number | null; output: string } {
  const run = spawnSync(process.execPath, [CHECK_SCRIPT, repoDirectory], { encoding: "utf8", env: { ...process.env, ...extraEnvironment } });
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
    "src/analytics.ts": `posthog.init("phc_public", { api_host: "https://us.i.posthog.com" });`,
    "src/bundled.ts": `posthog.init("phc_public", { disable_external_dependency_loading: true });`,
    "src/admin.ts": `const personalKey = "phx_${"a1B2".repeat(10)}";`,
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
  assert.match(output, /FAIL runtime-loading src\/analytics\.ts:1 /);
  assert.doesNotMatch(output, /src\/bundled\.ts/);
  assert.match(output, /FAIL secret-literal src\/admin\.ts:1 a posthog secret \(phx_a1B2\.\.\.\) is committed/);
  assert.doesNotMatch(output, /a1B2a1B2a1B2/);
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

test("PostHog runtime loading is judged per init, through options by reference, wrappers, and Nuxt config", () => {
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-js": "1.450.0", "@posthog/nuxt": "1.0.0" } }),
    "src/two-inits.ts": `posthog.init("phc_a", { disable_external_dependency_loading: true });\nposthog.init("phc_b", { api_host: "x" });`,
    "src/commented.ts": `// TODO set disable_external_dependency_loading: true\nposthog.init("phc_c", { api_host: "x" });`,
    "src/options.ts": `export const posthogOptions = { disable_external_dependency_loading: true };`,
    "src/by-reference.ts": `import { posthogOptions } from "./options";\nposthog.init(KEY, posthogOptions);`,
    "src/renamed.ts": `import ph from "posthog-js";\nph.init("phc_d", { api_host: "x" });`,
    "src/provider.tsx": `<PostHogProvider options={{ before_send: (event) => event }} apiKey={key}>`,
    "src/sample.ts": `posthog.init(\n  "<ph_project_api_key>",\n  { api_host: "x" },\n);`,
    "nuxt.config.ts": `export default defineNuxtConfig({ posthogConfig: { publicKey: "phc_x", clientConfig: {} } });`,
  });
  const { output } = runCheck(repoDirectory);
  const runtimeFailures = output.split("\n").filter((line) => line.startsWith("FAIL runtime-loading")).map((line) => line.split(" ")[2]);
  assert.deepEqual(runtimeFailures.sort(), ["nuxt.config.ts:1", "src/commented.ts:2", "src/provider.tsx:1", "src/renamed.ts:2", "src/two-inits.ts:2"]);
});

test("a committed personal key fails even in a repo with no browser code", () => {
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-node": "5.0.0" } }),
    "scripts/sync.ts": `const personalKey = "phx_${"a1B2".repeat(10)}";`,
  });
  const { exitCode, output } = runCheck(repoDirectory);
  assert.equal(exitCode, 1, output);
  assert.match(output, /FAIL secret-literal scripts\/sync\.ts:1 a posthog secret/);
});

test("Stripe, Clerk, Supabase, and Convex secrets fail when committed or given a client prefix", () => {
  const jwtWithPayload = (payload: Record<string, string>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJl`;
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "@stripe/stripe-js": "5.0.0", "@clerk/react-router": "1.0.0", "@supabase/supabase-js": "2.50.0", convex: "1.20.0" } }),
    ".env.example": "NEXT_PUBLIC_STRIPE_SECRET_KEY=\nSTRIPE_SECRET_KEY=\n",
    "src/clerk.ts": "const secret = import.meta.env.VITE_CLERK_SECRET_KEY;",
    "src/convex.ts": "const deployKey = process.env.EXPO_PUBLIC_CONVEX_DEPLOY_KEY;",
    "src/stripe.ts": `const key = "sk_live_${"x9Y8".repeat(8)}";`,
    "src/supabase.ts": `const admin = "${jwtWithPayload({ iss: "supabase", ref: "abc", role: "service_role" })}";`,
    "src/supabase-anon.ts": `const anon = "${jwtWithPayload({ iss: "supabase", ref: "abc", role: "anon" })}";`,
    "server/billing.ts": "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);",
    "server/webhook.ts": `const signingSecret = "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD";`,
    "src/vue.ts": "const key = process.env.VUE_APP_STRIPE_SECRET_KEY;",
    "docs/setup.md": "Set STRIPE_SECRET_KEY=rk_" + "live_51HxYz9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
  });
  const { output } = runCheck(repoDirectory);
  assert.match(output, /SDK modules: stripe, clerk, supabase, convex/);
  assert.match(output, /FAIL public-secret \.env\.example:1 NEXT_PUBLIC_STRIPE_SECRET_KEY exposes a server-only stripe secret/);
  assert.match(output, /FAIL public-secret src\/clerk\.ts:1 VITE_CLERK_SECRET_KEY exposes a server-only clerk secret/);
  assert.match(output, /FAIL public-secret src\/convex\.ts:1 EXPO_PUBLIC_CONVEX_DEPLOY_KEY exposes a server-only convex secret/);
  assert.match(output, /FAIL secret-literal src\/stripe\.ts:1 a stripe or clerk secret \(sk_live_\.\.\.\)/);
  assert.match(output, /FAIL secret-literal server\/webhook\.ts:1 a stripe or clerk secret \(whsec_C2\.\.\.\)/);
  assert.match(output, /FAIL secret-literal docs\/setup\.md:1 a stripe secret \(rk_live_\.\.\.\)/);
  assert.match(output, /FAIL public-secret src\/vue\.ts:1 VUE_APP_STRIPE_SECRET_KEY/);
  assert.match(output, /FAIL secret-literal src\/supabase\.ts:1 a supabase secret/);
  assert.doesNotMatch(output, /supabase-anon|server\/billing/);
});

test("a site that serves no CSP header gets a live note even when the repo declares an enforced policy, without changing the exit code", async (context) => {
  const site = spawn(process.execPath, ["-e", `require("node:http").createServer((request, response) => response.end("<p>hi</p>")).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`]);
  context.after(() => site.kill());
  const [portLine] = await once(site.stdout, "data");
  const repoDirectory = createRepo({
    "package.json": JSON.stringify({ dependencies: { "posthog-js": "1.400.0" } }),
    "package-lock.json": "{}",
    "netlify.toml": [
      `[build]\n  base = "site"\n  command = "npm ci && npm run build"`,
      `[[headers]]\n  for = "/*"\n  [headers.values]\n    Content-Security-Policy = "default-src 'self'; script-src 'self'"`,
    ].join("\n"),
    "src/analytics.ts": `posthog.init("phc_public", { disable_external_dependency_loading: true });`,
    ".browser-sdk-sites.json": JSON.stringify([`http://127.0.0.1:${String(portLine).trim()}/docs`]),
  });
  const { exitCode, output } = runCheck(repoDirectory, { SECURING_BROWSER_CODE_ALLOWS_LOOPBACK: "1" });
  assert.equal(exitCode, 0, output);
  assert.match(output, /^0 failing/m);
  assert.match(output, /^NOTE live-csp http:\/\/127\.0\.0\.1:\d+\/ serves no Content-Security-Policy header/m);
});
