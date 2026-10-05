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

function localAgentTask(overrides) {
  return {
    id: "a3a1072656b09d7d3",
    type: "local_agent",
    status: "running",
    description: "Fix review round 1",
    label: "Checking property-filter history in vercel.json",
    startTime: Date.now() - 128_000,
    model: "claude-opus-5-5[1m]",
    contextWindowSize: 1_000_000,
    tokenCount: 101_486,
    ...overrides,
  };
}

test("an unnamed background agent is headed by its task title with model, elapsed time and context use", () => {
  const rows = renderedRows({ columns: 149, tasks: [localAgentTask({})] });

  assert.deepEqual(rows, [
    { id: "a3a1072656b09d7d3", content: "Fix review round 1  opus-5-5 · 2m 08s · ctx 101.5k 10%" },
  ]);
});

test("a named agent is headed by its name and shows its effort", () => {
  const rows = renderedRows({ tasks: [localAgentTask({ name: "dotfiles-dispatch", effort: "high" })] });

  assert.match(rows[0].content, /^dotfiles-dispatch  opus-5-5 · high · /);
});

test("the row never shows the agent's live activity or its internal task type", () => {
  const rows = renderedRows({ tasks: [localAgentTask({})] });

  assert.equal(rows[0].content.includes("Checking property-filter"), false);
  assert.equal(rows[0].content.includes("local_agent"), false);
});

test("an agent whose model is not resolved yet still renders without it", () => {
  const rows = renderedRows({
    tasks: [{ id: "task-2", type: "local_agent", description: "Unnamed row probe", tokenCount: 0 }],
  });

  assert.deepEqual(rows, [{ id: "task-2", content: "Unnamed row probe  ctx 0" }]);
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
