import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { makeRepository, removeAll, runHook } from "./harness.mjs";

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "guard-workflow-home-"));
const repository = makeRepository();
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1", HOME: sandboxHome };

after(() => removeAll(sandboxHome, repository));

function prompt(text) {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUse(name, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${name}`, name, input }] } };
}

function toolResult(text, { toolUseId = "tool-x", isError = true } = {}) {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] } };
}

function skillRun(skillName) {
  const launchResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-Skill", content: `Launching skill: ${skillName}` }] } };
  return [toolUse("Skill", { skill: skillName }), launchResult];
}

function writeTranscript(entries) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(sandboxHome, "transcript-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return transcriptPath;
}

function decisionFor(payload, env = ATTENDED) {
  const processResult = runHook("guard-workflow.mjs", payload, env);
  assert.equal(processResult.status, 0, processResult.stderr);
  if (processResult.stdout === "") return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(processResult.stdout).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

function bashCall(command, transcriptPath, extra = {}) {
  return { tool_name: "Bash", tool_input: { command }, transcript_path: transcriptPath, ...extra };
}

function editCall(filePath, transcriptPath) {
  return { tool_name: "Edit", tool_input: { file_path: filePath, old_string: "a", new_string: "b" }, transcript_path: transcriptPath };
}

test("raw git commit and push outside /committing are denied in every command position", () => {
  const transcriptPath = writeTranscript([prompt("fix the typo")]);
  for (const command of [
    "git commit -m x",
    "git add -A && git commit -q -m wip --no-verify && git status",
    "env -u GH_TOKEN git push origin HEAD:refs/heads/someone/branch",
    "git -C /repo commit -F -",
    "cd /repo; /usr/bin/git push",
    "bash -c 'git commit -m x'",
    "GIT_EDITOR=true git commit",
    "HUSKY=0 git push",
    "GIT_DIR=.git git commit -m x",
    'sh -c "git push"',
    "git --git-dir .git commit -m x",
    "git --work-tree . push",
    "git -c alias.ci=commit ci -m x",
    `git -c "alias.ci=!git commit" ci`,
    `git -c 'alias.ci=!git commit' ci`,
    "eval 'git push origin'",
    `echo "don't" && git commit -m 'a b'`,
    "bash <<'EOF'\ngit commit -m x\nEOF",
    "cat <<EOF\n$(git push)\nEOF",
    "cat <<'EOF' | bash\ngit commit -m x\nEOF",
    "cat <<'EOF' > /tmp/s.sh && bash /tmp/s.sh\ngit commit -m x\nEOF",
    "cat <<EOF | sh\ngit push origin main\nEOF",
    `node -e 'require("child_process").execSync("git commit -m x")'`,
    `perl -e 'system("git commit -m x")'`,
  ]) {
    const { decision, reason } = decisionFor(bashCall(command, transcriptPath));
    assert.equal(decision, "deny", command);
    assert.match(reason, /\/committing/);
  }
});

test("git commands that neither commit nor push are allowed", () => {
  const transcriptPath = writeTranscript([prompt("look around")]);
  for (const command of ["git status", "git log --grep commit", "git commit-tree HEAD^{tree}", "echo git commit", "git push-not-a-command"]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("git commit or push inside quoted search text or a literal heredoc body is allowed", () => {
  const transcriptPath = writeTranscript([prompt("look around")]);
  for (const command of [
    "grep -n 'Raw git commit; git push' hooks/guard.mjs",
    "node land.ts --promote <<'MSG'\nfix: thing\n\ngit commit and git push stay denied\nMSG",
    "cat <<EOF\ngit push is denied\nEOF",
  ]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("pkill -f with a pattern that matches its own shell is denied", () => {
  const transcriptPath = writeTranscript([prompt("stop the server")]);
  for (const command of ['pkill -f "node server.js"', "pkill -9 -f vite", "sleep 1; pkill -fx vite"]) {
    const { decision, reason } = decisionFor(bashCall(command, transcriptPath));
    assert.equal(decision, "deny", command);
    assert.match(reason, /pgrep/);
  }
  for (const command of ["pkill -f '[v]ite'", "pkill -f '[n]ode server'", 'pkill -f "[n]ode server"', "pkill vite", "pgrep -f vite"]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("a /committing or /opening-prs run allows raw commits until the next carbon-unit prompt", () => {
  const commitSkillRun = writeTranscript([prompt("ship it"), ...skillRun("committing")]);
  assert.equal(decisionFor(bashCall('git commit -m "WIP set-aside"', commitSkillRun)).decision, "allow");
  const slashRun = writeTranscript([prompt("<command-name>/committing</command-name>\n<command-message>committing</command-message>")]);
  assert.equal(decisionFor(bashCall("git push", slashRun)).decision, "allow");
  const nextPrompt = writeTranscript([prompt("ship it"), ...skillRun("committing"), prompt("now change the colour")]);
  assert.equal(decisionFor(bashCall("git commit -m x", nextPrompt)).decision, "deny");
  const openPullRequestRun = writeTranscript([prompt("open a PR"), ...skillRun("opening-prs")]);
  assert.equal(decisionFor(bashCall('git add -A && git commit -m "WIP set-aside"', openPullRequestRun)).decision, "allow");
  const rejectedRun = writeTranscript([prompt("ship it"), toolUse("Skill", { skill: "committing" }), toolResult("The tool use was rejected.", { toolUseId: "tool-Skill" })]);
  assert.equal(decisionFor(bashCall("git commit -m x", rejectedRun)).decision, "deny");
});

test("subagents, unattended sessions, and unreadable input are never gated", () => {
  const transcriptPath = writeTranscript([prompt("fix it")]);
  assert.equal(decisionFor(bashCall("git push", transcriptPath, { agent_id: "agent-1" })).decision, "allow");
  assert.equal(decisionFor(bashCall("git push", transcriptPath), { CLAUDE_CODE_SESSION_ATTENDED: "0", HOME: sandboxHome }).decision, "allow");
  assert.equal(decisionFor(bashCall("git push", path.join(sandboxHome, "missing.jsonl"))).decision, "allow");
  const malformed = runHook("guard-workflow.mjs", "not json", ATTENDED);
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
});

test("the first repo edit of a session without /specifying is denied once", () => {
  const repoFile = path.join(repository, "a.txt");
  const fresh = writeTranscript([prompt("add an export button")]);
  const { decision, reason } = decisionFor(editCall(repoFile, fresh));
  assert.equal(decision, "deny");
  const afterDenial = writeTranscript([prompt("add an export button"), toolUse("Edit", { file_path: repoFile }), toolResult(`PreToolUse:Edit hook error: ${reason}`, { toolUseId: "tool-Edit" })]);
  assert.equal(decisionFor(editCall(repoFile, afterDenial)).decision, "allow");
  const hookSource = fs.readFileSync(path.resolve(import.meta.dirname, "../guard-workflow.mjs"), "utf8");
  const afterReadingSource = writeTranscript([prompt("add an export button"), toolUse("Read", { file_path: "guard-workflow.mjs" }), toolResult(hookSource, { toolUseId: "tool-Read", isError: false })]);
  assert.equal(decisionFor(editCall(repoFile, afterReadingSource)).decision, "deny");
});

test("running /specifying or /converging-reviews or reading a design spec clears the spec gate", () => {
  const repoFile = path.join(repository, "a.txt");
  const specRun = writeTranscript([prompt("add an export button"), ...skillRun("specifying")]);
  assert.equal(decisionFor(editCall(repoFile, specRun)).decision, "allow");
  const loopRun = writeTranscript([prompt("/converging-reviews"), ...skillRun("converging-reviews")]);
  assert.equal(decisionFor(editCall(repoFile, loopRun)).decision, "allow");
  const intentRead = writeTranscript([prompt("build it"), toolUse("Read", { file_path: path.join(sandboxHome, ".claude/specs/repo/export.intent.json") })]);
  assert.equal(decisionFor(editCall(repoFile, intentRead)).decision, "allow");
});

test("edits outside a git worktree or under ~/.claude skip the spec gate", () => {
  const transcriptPath = writeTranscript([prompt("note this")]);
  assert.equal(decisionFor(editCall(path.join(sandboxHome, "scratch/notes.md"), transcriptPath)).decision, "allow");
  fs.mkdirSync(path.join(sandboxHome, ".claude"), { recursive: true });
  assert.equal(decisionFor(editCall(path.join(sandboxHome, ".claude/projects/memory/fact.md"), transcriptPath)).decision, "allow");
});
