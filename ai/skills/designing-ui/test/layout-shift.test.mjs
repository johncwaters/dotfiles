import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const layoutShiftScript = new URL("../scripts/layout-shift.mjs", import.meta.url).pathname;
const fixturesDirectory = new URL("./fixtures/", import.meta.url);
const clickSaveStepsPath = new URL("click-save.json", fixturesDirectory).pathname;

function measureFixture(fixtureName, extraArguments = []) {
  const fixtureUrl = new URL(fixtureName, fixturesDirectory).href;
  const run = spawnSync(process.execPath, [layoutShiftScript, "--url", fixtureUrl, "--steps", clickSaveStepsPath, ...extraArguments], { encoding: "utf8" });
  return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("a page that reserves space for late content and button state reports no shift and writes a report with a screenshot per width and mode", (context) => {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "layout-shift-report-"));
  context.after(() => fs.rmSync(reportDirectory, { recursive: true, force: true }));
  const reportFile = path.join(reportDirectory, "ui.json");
  const { exitCode, stdout, stderr } = measureFixture("stable.html", ["--report", reportFile]);
  assert.equal(exitCode, 0, stdout + stderr);
  assert.equal(stdout, "");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.deepEqual(report.shifts, []);
  assert.deepEqual(report.screenshots.map((screenshot) => path.basename(screenshot)).sort(), ["ui-1440-dark.png", "ui-1440-light.png", "ui-640-dark.png", "ui-640-light.png"]);
  for (const screenshot of report.screenshots) assert.ok(fs.statSync(screenshot).size > 0, screenshot);
});

test("a late insert, a click-widened button label, and lazy content below the fold all fail in every width and mode, the click one despite hadRecentInput", () => {
  const { exitCode, stdout } = measureFixture("shifting.html");
  assert.equal(exitCode, 1);
  for (const width of [640, 1440]) {
    for (const mode of ["light", "dark"]) {
      const rowStart = `^${width} ${mode} \\| after`;
      assert.match(stdout, new RegExp(`${rowStart} load \\+\\d+ms \\| [\\d.]+ \\| \\S+shifting\\.html \\| P#below `, "m"));
      assert.match(stdout, new RegExp(`${rowStart} step 1 click #save \\+\\d+ms \\| [\\d.]+ \\(input-driven\\) \\| \\S+shifting\\.html \\| DIV#neighbor `, "m"));
      assert.match(stdout, new RegExp(`${rowStart} load scroll pass \\+\\d+ms \\| [\\d.]+ \\| \\S+shifting\\.html \\| P#below-fold `, "m"));
    }
  }
});
