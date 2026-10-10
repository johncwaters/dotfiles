import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hudPath = fileURLToPath(new URL("../hud.mjs", import.meta.url));
const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g;

function renderStatusLine(cavemanFlagContents, { payload = { model: { display_name: "Opus" } }, settings, environment = {} } = {}) {
  const homeDirectory = mkdtempSync(join(tmpdir(), "hud-home-"));
  try {
    mkdirSync(join(homeDirectory, ".claude"));
    if (cavemanFlagContents !== undefined) {
      writeFileSync(join(homeDirectory, ".claude", ".caveman-active"), cavemanFlagContents);
    }
    if (settings !== undefined) {
      writeFileSync(join(homeDirectory, ".claude", "settings.json"), JSON.stringify(settings));
    }
    const processResult = spawnSync(process.execPath, [hudPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, HOME: homeDirectory, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", ...environment },
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

const opusPayloadAt240kTokens = {
  model: { id: "claude-opus-5-5[1m]", display_name: "Opus" },
  context_window: {
    context_window_size: 1000000,
    used_percentage: 24,
    current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 240000 },
  },
  cost: { total_cost_usd: 12.4 },
};

test("context shows tokens against the configured auto-compact window and the per-call cache read cost", () => {
  assert.equal(
    renderStatusLine(undefined, { payload: opusPayloadAt240kTokens, settings: { autoCompactWindow: 300000 } }),
    "Model: Opus | ctx:240k/300k COMPRESS? ~$0.05/call | session:$12.40",
  );
});

test("context falls back to the model window when no auto-compact window is configured", () => {
  assert.equal(
    renderStatusLine(undefined, { payload: opusPayloadAt240kTokens }),
    "Model: Opus | ctx:240k/1M ~$0.05/call | session:$12.40",
  );
});

test("the auto-compact window environment variable takes precedence over settings.json", () => {
  const output = renderStatusLine(undefined, {
    payload: opusPayloadAt240kTokens,
    settings: { autoCompactWindow: 300000 },
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" },
  });
  assert.match(output, /ctx:240k\/200k/);
});

test("context derives tokens from used_percentage when current_usage is null", () => {
  const payloadBeforeFirstApiCall = {
    ...opusPayloadAt240kTokens,
    context_window: { context_window_size: 1000000, used_percentage: 24, current_usage: null },
  };
  assert.match(renderStatusLine(undefined, { payload: payloadBeforeFirstApiCall }), /ctx:240k\/1M/);
});

test("a model without a known cache price shows context but no per-call cost", () => {
  const sonnetPayload = { ...opusPayloadAt240kTokens, model: { id: "claude-sonnet-5-5", display_name: "Sonnet" }, cost: undefined };
  assert.equal(renderStatusLine(undefined, { payload: sonnetPayload }), "Model: Sonnet | ctx:240k/1M");
});
