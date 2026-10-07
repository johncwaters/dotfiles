import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hudPath = fileURLToPath(new URL("../hud.mjs", import.meta.url));
const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g;

function renderStatusLine(cavemanFlagContents) {
  const homeDirectory = mkdtempSync(join(tmpdir(), "hud-home-"));
  try {
    mkdirSync(join(homeDirectory, ".claude"));
    if (cavemanFlagContents !== undefined) {
      writeFileSync(join(homeDirectory, ".claude", ".caveman-active"), cavemanFlagContents);
    }
    const processResult = spawnSync(process.execPath, [hudPath], {
      input: JSON.stringify({ model: { display_name: "Opus" } }),
      encoding: "utf8",
      env: { ...process.env, HOME: homeDirectory },
    });
    assert.equal(processResult.status, 0);
    return processResult.stdout.replace(ANSI_ESCAPES, "");
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
}

const badgeByFlagValue = {
  caveman: "[CAVEMAN]",
  lite: "[CAVEMAN]",
  full: "[CAVEMAN]",
  ultracave: "[ULTRACAVE]",
  ultra: "[ULTRACAVE]",
  megacave: "[MEGACAVE]",
  wenyan: "[MEGACAVE]",
  "wenyan-lite": "[MEGACAVE]",
  "wenyan-full": "[MEGACAVE]",
  "wenyan-ultra": "[MEGACAVE]",
  commit: "[CAVEMAN:COMMIT]",
  review: "[CAVEMAN:REVIEW]",
  compress: "[CAVEMAN:COMPRESS]",
};

for (const [flagValue, expectedBadge] of Object.entries(badgeByFlagValue)) {
  test(`caveman flag "${flagValue}" shows ${expectedBadge} after the model segment`, () => {
    assert.equal(renderStatusLine(`${flagValue}\n`), `Model: Opus | ${expectedBadge}`);
  });
}

test("caveman flag off shows no badge", () => {
  assert.equal(renderStatusLine("off\n"), "Model: Opus");
});

test("an unknown caveman flag value shows no badge instead of falling back to [CAVEMAN]", () => {
  assert.equal(renderStatusLine("bogus\n"), "Model: Opus");
});

test("an inherited object property name as the flag value shows no badge", () => {
  assert.equal(renderStatusLine("constructor\n"), "Model: Opus");
});

test("a missing caveman flag file shows no badge", () => {
  assert.equal(renderStatusLine(undefined), "Model: Opus");
});
