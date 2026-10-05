import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const subagentHudPath = fileURLToPath(new URL("../subagent-hud.mjs", import.meta.url));
const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g;

function runSubagentHud(payload) {
  return spawnSync(process.execPath, [subagentHudPath], { input: JSON.stringify(payload), encoding: "utf8" });
}

function renderedRows(payload) {
  const processResult = runSubagentHud(payload);
  assert.equal(processResult.status, 0);
  return processResult.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .map((row) => ({ ...row, content: row.content.replace(ANSI_ESCAPES, "") }));
}

test("each subagent row shows its type, short model, effort, elapsed time and context use", () => {
  const twoMinutesEightSecondsAgo = Date.now() - 128_000;
  const rows = renderedRows({
    columns: 120,
    tasks: [
      {
        id: "task-1",
        name: "dotfiles-dispatch",
        type: "general-purpose",
        status: "running",
        description: "Routing note: kept on Claude",
        startTime: twoMinutesEightSecondsAgo,
        model: "claude-opus-5-5[1m]",
        effort: "high",
        contextWindowSize: 1_000_000,
        tokenCount: 94_000,
      },
    ],
  });

  assert.deepEqual(rows, [
    { id: "task-1", content: "dotfiles-dispatch  general-purpose · opus-5-5 · high · 2m 08s · ctx 94.0k 9%" },
  ]);
});

test("a subagent whose model is not resolved yet still renders without it", () => {
  const rows = renderedRows({ tasks: [{ id: "task-2", name: "scout", type: "Explore", tokenCount: 512 }] });

  assert.deepEqual(rows, [{ id: "task-2", content: "scout  Explore · ctx 512" }]);
});

test("the row never repeats the subagent's task description", () => {
  const rows = renderedRows({
    tasks: [{ id: "task-3", name: "bench", type: "general-purpose", description: "Routing note: kept on Claude" }],
  });

  assert.equal(rows[0].content.includes("Routing note"), false);
});

test("a subagent with no name or label is headed by its type, never its description", () => {
  const rows = renderedRows({
    tasks: [{ id: "task-4", type: "Explore", description: "Routing note: kept on Claude" }],
  });

  assert.deepEqual(rows, [{ id: "task-4", content: "Explore  Explore" }]);
});

test("a null entry in tasks is skipped and the remaining rows still render", () => {
  const rows = renderedRows({ tasks: [null, { id: "a", name: "x" }] });

  assert.deepEqual(rows, [{ id: "a", content: "x  " }]);
});

test("unparseable input leaves every default row in place and says why on stderr", () => {
  const processResult = spawnSync(process.execPath, [subagentHudPath], { input: "not json", encoding: "utf8" });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
  assert.match(processResult.stderr, /^subagent-hud: /);
});
