import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const layoutShiftScript = new URL("../scripts/layout-shift.mjs", import.meta.url).pathname;
const fixturesDirectory = new URL("./fixtures/", import.meta.url);
const clickSaveStepsPath = new URL("click-save.json", fixturesDirectory).pathname;

function measureFixture(fixtureName) {
  const fixtureUrl = new URL(fixtureName, fixturesDirectory).href;
  const run = spawnSync(process.execPath, [layoutShiftScript, "--url", fixtureUrl, "--steps", clickSaveStepsPath], { encoding: "utf8" });
  return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("a page that reserves space for late content and button state reports no shift", () => {
  const { exitCode, stdout, stderr } = measureFixture("stable.html");
  assert.equal(exitCode, 0, stdout + stderr);
  assert.equal(stdout, "");
});

test("a late insert, a click-widened button label, and lazy content below the fold all fail, the click one despite hadRecentInput", () => {
  const { exitCode, stdout } = measureFixture("shifting.html");
  assert.equal(exitCode, 1);
  for (const width of [640, 1440]) {
    assert.match(stdout, new RegExp(`^${width} \\| after load \\+\\d+ms \\| [\\d.]+ \\| \\S+shifting\\.html \\| P#below `, "m"));
    assert.match(stdout, new RegExp(`^${width} \\| after step 1 click #save \\+\\d+ms \\| [\\d.]+ \\(input-driven\\) \\| \\S+shifting\\.html \\| DIV#neighbor `, "m"));
    assert.match(stdout, new RegExp(`^${width} \\| after load scroll pass \\+\\d+ms \\| [\\d.]+ \\| \\S+shifting\\.html \\| P#below-fold `, "m"));
  }
});
