import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { protectedPaths } from "../../protected-paths.mjs";

const aiDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(aiDirectory);
const expectedClaudeRules = protectedPaths.map((protectedPath) => `Read(${protectedPath.path}${protectedPath.kind === "directory" ? "/**" : ""})`);
const glimmervoidFileEntries = ["~/.glimmervoid/config.json*", "~/.glimmervoid/secrets.env"];
const wholeGlimmervoidOrTeamReviewPattern = /~\/\.glimmervoid(\/?\*{0,2}["')\\]|\/team-review-)/;

test("the protected paths have one entry per personal credential path", () => {
  assert.equal(protectedPaths.length, new Set(protectedPaths.map((protectedPath) => protectedPath.path)).size);
  assert.ok(protectedPaths.every((protectedPath) => ["directory", "file"].includes(protectedPath.kind)));
  for (const glimmervoidFileEntry of glimmervoidFileEntries) {
    assert.deepEqual(protectedPaths.find((protectedPath) => protectedPath.path === glimmervoidFileEntry), { path: glimmervoidFileEntry, kind: "file" });
  }
  assert.ok(protectedPaths.every((protectedPath) => !protectedPath.path.startsWith("~/.glimmervoid") || glimmervoidFileEntries.includes(protectedPath.path)));
});

test("rendered Claude denies match the shared paths and scope Glimmervoid to its config and secrets files", () => {
  const renderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-"));
  const settingsPath = path.join(renderDirectory, "settings.json");
  try {
    const renderProcess = spawnSync("node", [
      path.join(aiDirectory, "render-settings.mjs"),
      path.join(aiDirectory, "settings.base.json"),
      path.join(repoRoot, "profiles/personal/settings.overlay.json"),
      settingsPath,
      renderDirectory,
    ], { encoding: "utf8" });
    assert.equal(renderProcess.status, 0, renderProcess.stderr);
    const renderedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const baseSettings = JSON.parse(fs.readFileSync(path.join(aiDirectory, "settings.base.json"), "utf8"));
    assert.deepEqual(baseSettings.permissions.deny.filter((rule) => rule.startsWith("Read(")), []);
    assert.deepEqual(renderedSettings.permissions.deny, [...baseSettings.permissions.deny, ...expectedClaudeRules]);
    assert.doesNotMatch(JSON.stringify(renderedSettings.permissions.deny), /\.codex\/auth\.json/);
    for (const glimmervoidFileEntry of glimmervoidFileEntries) {
      assert.ok(renderedSettings.permissions.deny.includes(`Read(${glimmervoidFileEntry})`), glimmervoidFileEntry);
    }
    assert.doesNotMatch(JSON.stringify(renderedSettings.permissions.deny), wholeGlimmervoidOrTeamReviewPattern);
  } finally {
    fs.rmSync(renderDirectory, { recursive: true, force: true });
  }
});
