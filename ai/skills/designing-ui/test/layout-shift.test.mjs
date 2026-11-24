import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const layoutShiftScript = new URL("../scripts/layout-shift.mjs", import.meta.url).pathname;
const fixturesDirectory = new URL("./fixtures/", import.meta.url);
const clickSaveStepsPath = new URL("click-save.json", fixturesDirectory).pathname;

function measureFixture(fixtureName, extraArguments = [], stepsPath = clickSaveStepsPath) {
  const fixtureUrl = new URL(fixtureName, fixturesDirectory).href;
  const run = spawnSync(process.execPath, [layoutShiftScript, "--url", fixtureUrl, "--steps", stepsPath, ...extraArguments], { encoding: "utf8" });
  return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("a page that reserves space for late content and button state, walked offline and with failing requests, reports no shift and names only the failures that a request hit and that still hold at the end with a screenshot per width and mode", (context) => {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "layout-shift-report-"));
  context.after(() => fs.rmSync(reportDirectory, { recursive: true, force: true }));
  const reportFile = path.join(reportDirectory, "ui.json");
  const failureStepsPath = path.join(reportDirectory, "failure-steps.json");
  fs.writeFileSync(failureStepsPath, JSON.stringify([{ offline: true }, { offline: false }, { failRequests: "**/no-such-path/**", status: 500 }, { failRequests: "**/api/**", status: 503 }, { click: "#save" }, { offline: true }, { failRequests: "**/never-requested/**" }]));
  const { exitCode, stdout, stderr } = measureFixture("stable.html", ["--report", reportFile], failureStepsPath);
  assert.equal(exitCode, 0, stdout + stderr);
  assert.equal(stdout, "");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.deepEqual(report.shifts, []);
  assert.deepEqual(report.forcedFailures, ["step 4 fail **/api/** with 503"]);
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
