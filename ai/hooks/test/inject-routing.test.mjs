import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOOKS_DIRECTORY, removeAll, runHook } from "./harness.mjs";

test("injected routing rules stay under the harness persisted-output threshold", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inject-routing-hook-"));
  try {
    const claudeDirectory = path.join(directory, ".claude");
    fs.mkdirSync(claudeDirectory);
    fs.copyFileSync(
      path.join(HOOKS_DIRECTORY, "..", "ROUTING.md"),
      path.join(claudeDirectory, "ROUTING.md"),
    );

    const processResult = runHook("inject-routing.mjs", {}, { HOME: directory });

    assert.equal(processResult.status, 0);
    assert.ok(Buffer.byteLength(processResult.stdout, "utf8") < 10000);
    assert.match(processResult.stdout, /<routing>/);
  } finally {
    removeAll(directory);
  }
});
