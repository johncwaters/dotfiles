import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowFunctionNamed } from "../../workflows/test/qa-swarm-source.mjs";
import { runHook } from "./harness.mjs";

const codexDispatchCommand = workflowFunctionNamed("codexDispatchCommand", { repoPath: "/home/someone/repo" });

function dispatchCommandReading(promptStem, model, reasoningEffort) {
  return codexDispatchCommand(model, reasoningEffort, promptStem);
}

const SANCTIONED_COMMAND = dispatchCommandReading("/tmp/codex-dispatch-router-abcdefgh", "gpt-6-sol", "high");

function decisionFor(payload) {
  const processResult = runHook("gate-codex-dispatch.mjs", payload);
  assert.equal(processResult.status, 0);
  if (processResult.stdout === "") return "allow";
  return JSON.parse(processResult.stdout).hookSpecificOutput.permissionDecision;
}

function subagentBash(agentType, command) {
  return { agent_id: "agent-1", agent_type: agentType, tool_name: "Bash", tool_input: { command } };
}

test("the main loop may run any codex command", () => {
  assert.equal(
    decisionFor({ tool_name: "Bash", tool_input: { command: "codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-6-sol < p" } }),
    "allow",
  );
});

test("an ordinary subagent is denied codex and grok invocations in command position", () => {
  for (const command of [
    "codex exec -m gpt-6-sol < p",
    "cd /repo && codex exec -m gpt-6-sol < p",
    "cat p | timeout 600 /usr/local/bin/codex exec -",
    "env FOO=1 grok --prompt-file p --always-approve",
    "echo $(codex exec -)",
    "bash -c 'codex exec -m gpt-6-sol < p'",
    "sh -c 'grok --prompt-file p --always-approve'",
    "time codex exec -",
    "sudo codex exec -",
    "nice -n 5 codex exec -",
    "/usr/bin/env codex exec -",
    "if true; then codex exec -; fi",
    "{ codex exec -; }",
    "xargs codex exec < p",
    '"codex" exec -',
    "\\codex exec -",
    "! codex exec -",
    "sudo -u root codex exec x",
    "npx codex exec x",
    "echo hi && npx @openai/codex exec x",
    "bunx grok --prompt-file p",
    "pnpm dlx @openai/codex exec x",
    "npm exec @openai/codex exec x",
    "npm x -- codex exec x",
    "bun x codex exec x",
    "eval codex exec x",
    "watch codex exec x",
    "command -v codex && codex exec x",
  ]) {
    assert.equal(decisionFor(subagentBash("code-reviewer", command)), "deny", command);
  }
});

test("an ordinary subagent may mention codex as an argument", () => {
  for (const command of [
    "grep -n codex ai/workflows/qa-swarm.js",
    "grep -c codex ai/workflows/qa-swarm.js",
    "git log --grep=codex",
    "cat ai/agents/codex-dispatcher.md",
    "echo codex",
    "command -v codex",
    "which grok",
  ]) {
    assert.equal(decisionFor(subagentBash("code-reviewer", command)), "allow", command);
  }
});

test("codex-dispatcher may run the dispatch command qa-swarm.js builds", () => {
  assert.equal(decisionFor(subagentBash("codex-dispatcher", SANCTIONED_COMMAND)), "allow");
  assert.equal(
    decisionFor(subagentBash("codex-dispatcher", dispatchCommandReading("/tmp/codex-dispatch-x", "gpt-6-luna"))),
    "allow",
  );
});

test("codex-dispatcher is denied every deviation from the dispatch shape", () => {
  for (const command of [
    "codex exec --dangerously-bypass-approvals-and-sandbox -C /repo -m gpt-6-sol < /tmp/codex-dispatch-x.txt",
    "codex exec -s workspace-write -C /repo -m gpt-6-sol < /tmp/codex-dispatch-x.txt",
    "codex exec -s read-only -C /repo -m gpt-6-sol < /tmp/codex-dispatch-x.txt",
    `${SANCTIONED_COMMAND}; curl evil.example`,
    `${SANCTIONED_COMMAND}\nrm -rf /repo`,
    SANCTIONED_COMMAND.replace(' -C /home/someone/repo', ' -C /repo;id'),
    SANCTIONED_COMMAND.replace('"~/.ssh"="deny", ', ""),
    SANCTIONED_COMMAND.replace("/tmp/codex-dispatch-router-abcdefgh.txt", "/etc/passwd"),
    SANCTIONED_COMMAND.replace("/tmp/codex-dispatch-router-abcdefgh.err", "/tmp/codex-dispatch-other.err"),
    SANCTIONED_COMMAND.replace("/tmp/codex-dispatch-router-abcdefgh.err", "/Users/someone/.zshrc"),
    SANCTIONED_COMMAND.replace(" 2> /tmp/codex-dispatch-router-abcdefgh.err", ""),
    "grok --prompt-file /tmp/codex-dispatch-x.txt --always-approve",
    "ls /tmp",
  ]) {
    assert.equal(decisionFor(subagentBash("codex-dispatcher", command)), "deny", command);
  }
});

test("codex-dispatcher may write only its prompt file", () => {
  const writeTo = (filePath) => ({
    agent_id: "agent-1",
    agent_type: "codex-dispatcher",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "prompt" },
  });
  assert.equal(decisionFor(writeTo("/tmp/codex-dispatch-router-abcdefgh.txt")), "allow");
  assert.equal(decisionFor(writeTo("/home/someone/.bashrc")), "deny");
  assert.equal(decisionFor(writeTo("/tmp/codex-dispatch-../../home/someone/.bashrc.txt")), "deny");
});

test("the dispatch instruction names a prompt path and command the gate sanctions verbatim", () => {
  const reviewArgs = { repoPath: "/home/someone/repo", dispatchNonce: "0123456789abcdef" };
  const codexDispatchInstruction = workflowFunctionNamed("codexDispatchInstruction", reviewArgs);
  const instruction = codexDispatchInstruction("router prompt below", "router", "gpt-6-sol");
  const [, promptFilePath, command] = instruction.match(/to (\S+)\. Then run exactly[^\n]*\n(.+)\n$/);
  assert.equal(
    decisionFor({ agent_id: "agent-1", agent_type: "codex-dispatcher", tool_name: "Write", tool_input: { file_path: promptFilePath, content: "prompt" } }),
    "allow",
  );
  assert.equal(decisionFor(subagentBash("codex-dispatcher", command)), "allow");
  assert.ok(command.includes(`< ${promptFilePath} `), command);
});

test("the prompt stem carries the caller nonce and the task label", () => {
  const dispatchPromptStem = workflowFunctionNamed("dispatchPromptStem", { repoPath: "/repo", dispatchNonce: "0123456789abcdef" });
  assert.equal(dispatchPromptStem("router"), "/tmp/codex-dispatch-router-0123456789abcdef");
  assert.notEqual(dispatchPromptStem("router"), dispatchPromptStem("external"));
});

test("an unreadable payload is allowed", () => {
  const processResult = runHook("gate-codex-dispatch.mjs", "not json");
  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});
