import assert from "node:assert/strict";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

test("an unchallenged plan is denied with skill instructions", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n2. Test the thing" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /plan-challenge/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /CHALLENGE:/);
});

test("a stamped plan is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\nCHALLENGE: 1 kept, 0 shrunk, 1 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a heading-style stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n## Challenge: 1 kept, 0 shrunk, 0 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("mid-plan challenge prose is denied", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nChallenge: is step 3 really needed?\n\n2. Test the thing",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("a stamp followed by later plan lines is denied", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nCHALLENGE: 1 kept, 0 shrunk, 1 cut\n\n2. One more thing",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("the deny reason names the path for a context that cannot spawn agents", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /cannot spawn agents returns the plan to its caller unstamped/,
  );
});

test("a bold stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n**CHALLENGE: 2 kept, 1 shrunk, 0 cut**" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an inline-code stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n`CHALLENGE: 1 kept, 0 shrunk, 0 cut`" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an italic stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n_CHALLENGE: 1 kept, 0 shrunk, 0 cut_" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a list-item stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Do the thing\n\n- CHALLENGE: 2 kept, 1 shrunk, 0 cut" },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a lane-list suffix on the stamp is allowed", () => {
  const processResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "1. Do the thing\n\nCHALLENGE: 2 kept, 1 shrunk, 0 cut (lanes: necessity, leverage)",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("the plan gate ignores other tools and empty plans", () => {
  const otherToolResult = runHook("challenge-plan.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "a.txt", content: "no plan here" },
  });
  assert.equal(otherToolResult.status, 0);
  assert.equal(otherToolResult.stdout, "");

  const emptyPlanResult = runHook("challenge-plan.mjs", {
    tool_name: "ExitPlanMode",
    tool_input: { plan: "   " },
  });
  assert.equal(emptyPlanResult.status, 0);
  assert.equal(emptyPlanResult.stdout, "");
});
