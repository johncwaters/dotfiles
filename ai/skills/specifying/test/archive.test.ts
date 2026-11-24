import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("archive built refuses until every unit has a pushed Ticket trailer or a pushed commit named by --landed", () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "spec-archive-"));
  try {
    const repoRoot = path.join(temporaryHome, "decks");
    const git = (...gitArguments: string[]) => spawnSync("git", ["-C", repoRoot, "-c", "user.name=t", "-c", "user.email=t@t", ...gitArguments], { encoding: "utf8" });
    fs.mkdirSync(repoRoot);
    git("init", "-q", "-b", "main");
    spawnSync("git", ["init", "-q", "--bare", path.join(temporaryHome, "origin.git")]);
    git("remote", "add", "origin", path.join(temporaryHome, "origin.git"));
    git("commit", "-q", "--allow-empty", "-m", "Add the CSV writer", "-m", "Ticket: export/U1");
    git("push", "-q", "origin", "main");
    const specPath = path.join(temporaryHome, ".agents", "specs", "decks", "export.json");
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    const unit = (id: string) => ({ id, kind: "unit", title: id, reads: [], changes: ["src"], checks: [], serves: [1] });
    fs.writeFileSync(specPath, JSON.stringify({ status: "challenged", repoRoot, nodes: [unit("U1"), unit("U2")], edges: [] }));
    fs.writeFileSync(specPath.replace(/\.json$/, ".intent.json"), "{}");
    const archiveBuilt = (...flags: string[]) => JSON.parse(spawnSync("node", [path.resolve(import.meta.dirname, "../archive.ts"), specPath, "built", ...flags], { encoding: "utf8", env: { ...process.env, HOME: temporaryHome } }).stdout);

    const refusal = { outcome: "REFUSED", errors: ["U2: no pushed commit carries trailer Ticket: export/U2; land it, pass --landed U2=<sha> for its pushed commit that lacks the trailer, or archive abandoned"] };
    assert.deepEqual(archiveBuilt(), refusal);
    git("commit", "-q", "--allow-empty", "-m", "Add the price column");
    const untrailedSha = git("rev-parse", "HEAD").stdout.trim();
    assert.deepEqual(archiveBuilt("--landed", `U2=${untrailedSha}`), { outcome: "REFUSED", errors: [`U2: --landed U2=${untrailedSha} names no commit on a pushed branch of ${fs.realpathSync(repoRoot)}`] });
    git("push", "-q", "origin", "main");
    assert.equal(archiveBuilt("--landed", `U2=${untrailedSha}`).outcome, "ARCHIVED");
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});
