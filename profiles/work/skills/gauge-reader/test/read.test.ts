import { deepEqual, equal, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scriptPath = join(import.meta.dirname, "../read.ts");
const fixtureRunId = "cmviaewes00bm01ipgd7mcxqd";

test("a cached Codex run that fetched docs only through its own web tool reads as stale values from unlogged web, with no gauge call", (context) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "gauge-reader-"));
  context.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  cpSync(join(import.meta.dirname, "fixtures", fixtureRunId), join(cacheRoot, "runs", fixtureRunId), { recursive: true });
  const readerProcess = spawnSync(process.execPath, [scriptPath, fixtureRunId, "--cache-dir", cacheRoot], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, GAUGE_BIN: "/bin/false" },
  });
  equal(readerProcess.status, 0, readerProcess.stderr);
  match(readerProcess.stdout, /\| cmviaewes00bm01ipgd7mcxqd \| CODEX_CLI gpt-6\.1-sol \| SUCCEEDED \| 0 \|/);
  const [row] = JSON.parse(readFileSync(join(cacheRoot, fixtureRunId, "runs.json"), "utf8"));
  deepEqual(row.sandboxDocsRequests, []);
  deepEqual(row.facts.map((fact: { name: string; writtenValues: string[]; passed: boolean; provenance: { origin: string } }) =>
    [fact.name, fact.writtenValues, fact.passed, fact.provenance.origin]), [
    ["token env var", ["NEXT_PUBLIC_POSTHOG_KEY"], false, "unlogged-web"],
    ["defaults", ["2026-01-30"], false, "unlogged-web"],
  ]);
  deepEqual(row.failingCriteria, ["Env var names match the docs", "Defaults match the docs"]);
});
