import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agyStep, runHook } from "./harness.mjs";

function stopDecision(lastAssistantMessage, extraPayload = {}) {
  const hookProcess = runHook("require-carbon-unit.mjs", { last_assistant_message: lastAssistantMessage, ...extraPayload });
  if (hookProcess.stdout === "") return { decision: "allow", reason: "" };
  return JSON.parse(hookProcess.stdout);
}

function transcriptOf(...userEntries) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "carbon-unit-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, userEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return transcriptPath;
}

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const stopFeedback = (reason) => ({ type: "user", isMeta: true, message: { role: "user", content: `Stop hook feedback:\n${reason}` } });
const ownFeedback = stopFeedback('The reply says "user" where <output_style> requires "carbon unit" or "carbon units".');

test("the hook blocks once per turn on its own feedback, not on another Stop hook's", () => {
  const reply = "Landed. The user can rerun dot.";
  const afterCommitGate = transcriptOf(prompt("ship it"), stopFeedback("This turn ends with uncommitted edits this session made and no /landing since: a.ts."));
  assert.equal(stopDecision(reply, { stop_hook_active: true, transcript_path: afterCommitGate }).decision, "block");
  const afterOwnBlock = transcriptOf(prompt("ship it"), ownFeedback);
  assert.equal(stopDecision(reply, { stop_hook_active: true, transcript_path: afterOwnBlock }).decision, "allow");
  const nextTurn = transcriptOf(prompt("ship it"), ownFeedback, prompt("and again"));
  assert.equal(stopDecision(reply, { transcript_path: nextTurn }).decision, "block");
});

test("Codex and agy replies are judged once per turn, agy's read from its transcript", () => {
  const codexStop = (extraPayload) => runHook("require-carbon-unit.mjs", { last_assistant_message: "The user can rerun dot.", ...extraPayload }, {}, process.cwd(), ["--agent=codex"]).stdout;
  assert.equal(JSON.parse(codexStop({ transcript_path: transcriptOf(prompt("ship it"), ownFeedback) })).decision, "block");
  assert.equal(codexStop({ stop_hook_active: true }), "");
  const agyTranscript = transcriptOf(agyStep(0, "USER_INPUT", "<USER_REQUEST>\nship it\n</USER_REQUEST>"), agyStep(1, "PLANNER_RESPONSE", "Landed. The user can rerun dot."));
  const agyStop = (extraPayload) => runHook("require-carbon-unit.mjs", { transcriptPath: agyTranscript, ...extraPayload }, {}, process.cwd(), ["--agent=agy"]).stdout;
  assert.equal(JSON.parse(agyStop({})).decision, "continue");
  const agyStopFeedback = (stepIndex, reason) => agyStep(stepIndex, "SYSTEM_MESSAGE", `<SYSTEM_MESSAGE>\nStop hook blocked termination: ${reason}\n</SYSTEM_MESSAGE>`);
  const afterCommitGate = transcriptOf(agyStep(0, "USER_INPUT", "<USER_REQUEST>\nship it\n</USER_REQUEST>"), agyStopFeedback(1, "This turn ends with uncommitted edits this session made and no /landing since: a.ts."), agyStep(2, "PLANNER_RESPONSE", "Landed. The user can rerun dot."));
  const afterOwnBlock = transcriptOf(agyStep(0, "USER_INPUT", "<USER_REQUEST>\nship it\n</USER_REQUEST>"), agyStopFeedback(1, 'The reply says "user" where <output_style> requires "carbon unit".'), agyStep(2, "PLANNER_RESPONSE", "Landed. The user can rerun dot."));
  const agyContinuedStop = (transcriptPath) => runHook("require-carbon-unit.mjs", { transcriptPath, continuationActive: false, executionNum: 1 }, {}, process.cwd(), ["--agent=agy"]).stdout;
  assert.equal(JSON.parse(agyContinuedStop(afterCommitGate)).decision, "continue");
  assert.equal(agyContinuedStop(afterOwnBlock), "");
});

test("a reply naming people in prose is blocked once with each word named", () => {
  const { decision, reason } = stopDecision("Done. The user can rerun it, and Developers see the People list.");
  assert.equal(decision, "block");
  assert.match(reason, /"user", "Developers", "People"/);
  assert.equal(stopDecision("The user can rerun it.", { stop_hook_active: true }).decision, "allow");
  assert.equal(stopDecision("The user can rerun it.", { agent_id: "agent-1" }).decision, "allow");
  assert.equal(stopDecision("Wrap the SQL in ``` before pasting. The user then reruns it.").decision, "block");
});

test("code, quotes, identifiers, and user-level terms pass", () => {
  const passingReplies = [
    "The carbon unit can rerun it.",
    "Renamed `user_id` in the `persons` table.",
    "```sql\nselect * from users;\n```\nDone.",
    "> the user said ship it\nShipped.",
    'The error reads "user not found".',
    "Set it in user-level settings; read user_id and user.name from https://example.com/users/1.",
  ];
  for (const reply of passingReplies) {
    assert.equal(stopDecision(reply).decision, "allow", reply);
  }
});

test("a reply handing the carbon unit a command it could run itself is sent back once per turn", () => {
  const handOffs = [
    "Run the eval in your terminal:\n```bash\nnpm run eval -- --dimension tone\n```",
    "When ready, type `! npm test` and paste the output.",
    "`! ./script/bootstrap`",
    "You can run:\n```\nbash /repo/script/check.sh\n```",
    "Run this in your terminal:\n\n```bash\nnpm test\n```",
  ];
  for (const reply of handOffs) {
    const { decision, reason } = stopDecision(reply, { cwd: "/repo" });
    assert.equal(decision, "block", reply);
    assert.match(reason, /commands you can run yourself/);
  }
  const selfRunFeedback = stopFeedback("The reply hands over `npm test`, commands you can run yourself.");
  const afterSendBack = transcriptOf(prompt("run the evals"), selfRunFeedback);
  assert.equal(stopDecision("`! npm test`", { transcript_path: afterSendBack }).decision, "allow");
  assert.equal(stopDecision("`! npm test`", { transcript_path: transcriptOf(prompt("run the evals"), ownFeedback) }).decision, "block");
});

test("interactive hand-offs, one script file outside the repo, and commands shown as records pass", () => {
  const passingReplies = [
    "Run this in your terminal:\n```bash\ngh auth login\n```",
    "Run `! bash /home/me/scratch/setup-keys.sh` here.",
    "I ran:\n```bash\nnpm run eval -- --dimension tone\n```\nAll dimensions passed.",
    "Example:\n```bash\nnode x.mjs\n```",
    "Interactive steps ship as one script file, never a list of `!` commands.",
    "Run `! bash ~/setup-keys.sh` in your terminal.",
    "Run this in your terminal:\n```bash\ncd ~/.dotfiles\nsudo ./install.sh\n```",
    "Run this in your terminal:\n```bash\ngh auth login \\\n  --hostname github.com\n```",
    "Run `! npx wrangler login` here.",
    "This rewrites published history, so it is your call:\n\n`! git push --force origin main`",
    "Done. The hook now sends back a reply carrying a `! cmd` line or span.",
    "Run `! bash ~/scratch/setup-keys.sh --profile work` in your terminal.",
    "Run this in your terminal:\n```bash\nenv DEBIAN_FRONTEND=noninteractive sudo apt install foo\n```",
    "Run `! yarn login` here.",
  ];
  for (const reply of passingReplies) {
    assert.equal(stopDecision(reply, { cwd: "/repo" }).decision, "allow", reply);
  }
  assert.equal(stopDecision("Run `! bash ~/scratch/login-steps.sh` in your terminal.", { cwd: os.homedir() }).decision, "allow");
  const { decision, reason } = stopDecision("`! gh auth login`\n`! op signin`", { cwd: "/repo" });
  assert.equal(decision, "block");
  assert.match(reason, /one script file/);
});
