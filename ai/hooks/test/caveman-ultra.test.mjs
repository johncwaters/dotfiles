import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOOKS_DIRECTORY } from "./harness.mjs";

function runCavemanUltraWithHome(home) {
  return spawnSync("node", [path.join(HOOKS_DIRECTORY, "caveman-ultra.mjs")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CAVEMAN_DEFAULT_MODE: "ultra" },
  });
}

function makeHomeHoldingUltraFlag() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-ultra-hook-"));
  fs.mkdirSync(path.join(home, ".claude"));
  return home;
}

test("the caveman flag is written for its owner only", () => {
  const home = makeHomeHoldingUltraFlag();
  const flagPath = path.join(home, ".claude", ".caveman-active");
  fs.writeFileSync(flagPath, "ultra", "utf8");
  fs.chmodSync(flagPath, 0o644);

  const processResult = runCavemanUltraWithHome(home);

  assert.equal(processResult.status, 0);
  assert.equal(fs.readFileSync(flagPath, "utf8"), "ultra");
  assert.equal(fs.statSync(flagPath).mode & 0o777, 0o600);
});

test("a symlinked caveman flag path is replaced rather than followed", () => {
  const home = makeHomeHoldingUltraFlag();
  const flagPath = path.join(home, ".claude", ".caveman-active");
  const redirectedPath = path.join(home, "redirected-target");
  fs.writeFileSync(redirectedPath, "keep me", "utf8");
  fs.symlinkSync(redirectedPath, flagPath);

  const processResult = runCavemanUltraWithHome(home);

  assert.equal(processResult.status, 0);
  assert.equal(fs.readFileSync(redirectedPath, "utf8"), "keep me");
  assert.equal(fs.lstatSync(flagPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(flagPath, "utf8"), "ultra");
});

test("the caveman hook leaves no temporary flag behind", () => {
  const home = makeHomeHoldingUltraFlag();
  fs.writeFileSync(path.join(home, ".claude", ".caveman-active"), "ultra", "utf8");

  assert.equal(runCavemanUltraWithHome(home).status, 0);

  const claudeEntries = fs.readdirSync(path.join(home, ".claude"));
  assert.deepEqual(claudeEntries, [".caveman-active"]);
});
