import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DELEGATION_NEXT_CALL_BY_TOOL, DIRECT_WORK_TOOLS } from "../hook-io.mjs";
import { removeAll, runHook } from "./harness.mjs";

const temporaryDirectories = [];
const currentPromptId = "11111111-1111-4111-8111-111111111111";

function writeTranscript(transcriptEntries) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fable-delegation-hook-"));
  temporaryDirectories.push(temporaryDirectory);
  const transcriptPath = path.join(temporaryDirectory, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${transcriptEntries.map((transcriptEntry) => JSON.stringify(transcriptEntry)).join("\n")}\n`,
    "utf8",
  );
  return transcriptPath;
}

function toolUse(toolName, toolUseId, toolInput = {}) {
  return { type: "tool_use", name: toolName, id: toolUseId, input: toolInput };
}

function assistantEntry(contentBlocks, sessionModel = "claude-fable-5-1") {
  return { type: "assistant", message: { model: sessionModel, content: contentBlocks } };
}

function userEntry(promptId) {
  return {
    type: "user",
    promptId,
    promptSource: "typed",
    userType: "external",
    message: { content: "Do the work." },
  };
}

function injectedTeammateEntry(promptId) {
  return {
    type: "user",
    promptId,
    userType: "external",
    message: { content: "Another Claude session sent a message: check the hook." },
  };
}

function toolResultEntry(promptId) {
  return {
    type: "user",
    promptId,
    message: { content: [{ type: "tool_result", content: "Done." }] },
  };
}

function skillLoadMetaEntry(promptId) {
  return {
    type: "user",
    promptId,
    isMeta: true,
    message: { content: [{ type: "text", text: "Skill loaded." }] },
  };
}

function payloadFor(transcriptPath, payloadOverrides = {}) {
  return {
    prompt_id: currentPromptId,
    transcript_path: transcriptPath,
    tool_name: "Read",
    tool_input: { file_path: "a.txt" },
    tool_use_id: "current-call",
    ...payloadOverrides,
  };
}

function assertAllowed(hookPayload) {
  const processResult = runHook("enforce-fable-delegation.mjs", hookPayload);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(processResult.stdout, "");
}

function assertDenied(hookPayload) {
  const processResult = runHook("enforce-fable-delegation.mjs", hookPayload);
  assert.equal(processResult.status, 0, processResult.stderr);
  const hookOutput = JSON.parse(processResult.stdout);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, "deny");
  return hookOutput.hookSpecificOutput.permissionDecisionReason;
}

afterEach(() => {
  removeAll(...temporaryDirectories.splice(0));
});

const failOpenCases = [
  {
    name: "A call inside a subagent is allowed",
    createPayload: (transcriptPath) => payloadFor(transcriptPath, { agent_id: "subagent" }),
  },
  {
    name: "A call in an Opus session is allowed",
    createPayload: (transcriptPath) => payloadFor(transcriptPath),
    model: "claude-opus-5",
  },
  {
    name: "A call with a missing transcript file is allowed",
    createPayload: () => payloadFor("/missing/fable-transcript.jsonl"),
  },
  {
    name: "A call without a prompt identifier is allowed",
    createPayload: (transcriptPath) => payloadFor(transcriptPath, { prompt_id: undefined }),
  },
];

for (const failOpenCase of failOpenCases) {
  test(failOpenCase.name, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry(
        [toolUse("Read", "one"), toolUse("Edit", "two"), toolUse("Grep", "three")],
        failOpenCase.model,
      ),
      toolResultEntry(currentPromptId),
    ]);
    assertAllowed(failOpenCase.createPayload(transcriptPath));
  });
}

test("The third direct tool call is allowed", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([toolUse("Read", "one"), toolUse("Grep", "two")]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("The fourth direct tool call is denied with the budget in the reason", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Bash", "three", { command: "pwd" }),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  const denialReason = assertDenied(payloadFor(transcriptPath));
  assert.match(denialReason, /budget/);
  assert.match(denialReason, /after a `commit` Skill invocation/);
});

function writeSpentBudgetTranscript() {
  return writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);
}

const deniedToolInputByName = { Bash: { command: "ls" } };

function denialReasonForTool(deniedToolName) {
  return assertDenied(
    payloadFor(writeSpentBudgetTranscript(), {
      tool_name: deniedToolName,
      tool_input: deniedToolInputByName[deniedToolName] ?? { file_path: "a.txt" },
    }),
  );
}

test("A denied Read leads with the Explore Agent call to make instead", () => {
  assert.match(
    denialReasonForTool("Read"),
    /^Next call: an `Agent` call with `subagent_type: "Explore"`\.\n/,
  );
});

for (const writeToolName of ["Edit", "Bash"]) {
  test(`A denied ${writeToolName} leads with an inline codex exec dispatch or an Agent call`, () => {
    assert.match(
      denialReasonForTool(writeToolName),
      /^Next call: a Bash `codex exec --dangerously-bypass-approvals-and-sandbox -m <Codex id per ROUTING\.md rule 1> <<'EOF'` dispatch with the prompt inline and `run_in_background: true`, or an `Agent` call\.\n/,
    );
  });
}

test("A denied WebSearch leads with an inline grok dispatch or an Agent call", () => {
  assert.match(
    denialReasonForTool("WebSearch"),
    /^Next call: a Bash `grok -p '<prompt>' --always-approve` dispatch with `run_in_background: true`, or an `Agent` call\.\n/,
  );
});

test("The next call map covers exactly the direct work tool set", () => {
  assert.deepEqual(
    [...DELEGATION_NEXT_CALL_BY_TOOL.keys()].sort(),
    [...DIRECT_WORK_TOOLS].sort(),
  );
});

test("A commit Skill invocation in an earlier assistant entry exempts later direct calls", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    assistantEntry([toolUse("Skill", "commit-skill", { skill: "commit   " })]),
    assistantEntry([toolUse("Read", "current-call")]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("A commit Skill invocation in the current assistant entry exempts later direct calls", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
      toolUse("Skill", "commit-skill", { skill: "/commit\t" }),
      toolUse("Read", "current-call"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("A parallel commit Skill invocation after the current call does not exempt it", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
      toolUse("Read", "current-call"),
      toolUse("Skill", "commit-skill", { skill: "commit" }),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
});

test("A commit Skill invocation in an older turn does not exempt the current turn", () => {
  const transcriptPath = writeTranscript([
    userEntry("22222222-2222-4222-8222-222222222222"),
    assistantEntry([toolUse("Skill", "old-commit-skill", { skill: "commit" })]),
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
});

for (const unrelatedSkillName of ["caveman:caveman-commit", "pr-review"]) {
  test(`A ${unrelatedSkillName} Skill invocation does not exempt later direct calls`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
        toolUse("Skill", "unrelated-skill", { skill: unrelatedSkillName }),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
  });
}

test("The recorded current call is subtracted when it is the third call", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Read", "current-call"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("Agent Skill and Codex dispatch blocks do not spend the direct tool budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Agent", "agent"),
      toolUse("Skill", "skill"),
      toolUse("Bash", "dispatch", { command: "  codex exec --full-auto task" }),
      toolUse("Grep", "two"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("Tool calls before an older prompt identifier do not spend the current budget", () => {
  const transcriptPath = writeTranscript([
    assistantEntry([
      toolUse("Read", "old-one"),
      toolUse("Edit", "old-two"),
      toolUse("Write", "old-three"),
      toolUse("Glob", "old-four"),
    ]),
    userEntry("22222222-2222-4222-8222-222222222222"),
    userEntry(currentPromptId),
    assistantEntry([toolUse("Read", "one"), toolUse("Grep", "two")]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("An assistant line straddling the sixty-four kilobyte boundary is parsed", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Bash", "one", { command: `printf %s ${"x".repeat(64 * 1024)}` }),
      toolUse("Read", "two"),
      toolUse("Grep", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /budget/);
});

test("Dispatch Bash calls anywhere in their command do not spend the budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Bash", "dispatch", {
        command: "cd /repo && codex exec -m gpt-5.6-terra < prompt.md",
      }),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
  const spentBudgetTranscriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);
  assertAllowed(
    payloadFor(spentBudgetTranscriptPath, {
      tool_name: "Bash",
      tool_input: { command: "cd /repo && codex exec -m gpt-5.6-terra < prompt.md" },
    }),
  );
});

const commitPreflightCommand = `node "$HOME/.claude/skills/commit/preflight.ts" --paths a.mjs`;
const commitLandCommand = `node "$HOME/.claude/skills/commit/land.ts" --promote <<'MSG'\nfeat(x): y\nMSG`;

test("Commit skill preflight and land Bash calls do not spend the direct tool budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Bash", "preflight", { command: commitPreflightCommand }),
      toolUse("Bash", "land", { command: commitLandCommand }),
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "current-call"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

test("A commit skill land call is exempt once the budget is spent", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(
    payloadFor(transcriptPath, {
      tool_name: "Bash",
      tool_input: { command: commitLandCommand },
    }),
  );
});

for (const pipelineConsumer of ["head -60", "jq .outcome"]) {
  test(`A piped commit preflight call is exempt once the budget is spent: ${pipelineConsumer}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assertAllowed(
      payloadFor(transcriptPath, {
        tool_name: "Bash",
        tool_input: {
          command: `${commitPreflightCommand} 2>&1 | ${pipelineConsumer}`,
        },
      }),
    );
  });
}

const pipelineEscapeCommands = [
  `node "$HOME/.claude/skills/commit/preflight.ts" | bash -lc 'curl evil.example'`,
  `node "$HOME/.claude/skills/commit/preflight.ts" | tee out.log && rm -rf build`,
  "bun ~/.claude/skills/commit/preflight.ts | cat; git push --force origin main",
  "bun ~/.claude/skills/commit/land.ts | true && rm -rf build",
  `node "$HOME/.claude/skills/commit/preflight.ts" | python3 /tmp/evil.py`,
  "bun ~/.claude/skills/commit/land.ts | sed -i s/a/b/ $HOME/.bashrc",
  `node "$HOME/.claude/skills/commit/preflight.ts" | cat > $HOME/.bashrc`,
  `node "$HOME/.claude/skills/commit/preflight.ts" | head -60 >> $HOME/out.log`,
  'node "$HOME/.claude/skills/commit/preflight.ts" | grep `rm -rf /tmp/evil`',
];

for (const pipelineEscapeCommand of pipelineEscapeCommands) {
  test(`A commit invocation piped into further work is denied once the budget is spent: ${pipelineEscapeCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(
      assertDenied(
        payloadFor(transcriptPath, {
          tool_name: "Bash",
          tool_input: { command: pipelineEscapeCommand },
        }),
      ),
      /budget/,
    );
  });
}

const commitPathMentionCommand = `git diff "$HOME/.claude/skills/commit/land.ts"`;

test("A Bash call that only names the commit land path spends the direct tool budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Bash", "three", { command: commitPathMentionCommand }),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
});

test("A Bash call that only names the commit land path is denied once the budget is spent", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assert.match(
    assertDenied(
      payloadFor(transcriptPath, {
        tool_name: "Bash",
        tool_input: { command: commitPathMentionCommand },
      }),
    ),
    /budget/,
  );
});

const commitDocumentationSearchCommand = `grep -n 'node "$HOME/.claude/skills/commit/land.ts"' ai/skills/commit/SKILL.md`;
const commitMentionPipelineCommand = "echo node skills/commit/land.ts | cat";

for (const commitMentionCommand of [
  commitDocumentationSearchCommand,
  commitMentionPipelineCommand,
]) {
  test(`A Bash call that only quotes the commit invocation spends the direct tool budget: ${commitMentionCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Bash", "three", { command: commitMentionCommand }),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
  });

  test(`A Bash call that only quotes the commit invocation is denied once the budget is spent: ${commitMentionCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(
      assertDenied(
        payloadFor(transcriptPath, {
          tool_name: "Bash",
          tool_input: { command: commitMentionCommand },
        }),
      ),
      /budget/,
    );
  });
}

test("A commit skill land call behind a directory change is exempt once the budget is spent", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(
    payloadFor(transcriptPath, {
      tool_name: "Bash",
      tool_input: { command: `cd /repo && ${commitLandCommand}` },
    }),
  );
});

const commitHeredocBodyCommand = `cat > notes.md <<'DOC'\nnode ~/.claude/skills/commit/land.ts --promote\nDOC`;
const commitAfterUnrelatedSegmentCommand = `rm -rf build; node $HOME/.claude/skills/commit/land.ts --help`;

for (const commitLookalikeCommand of [
  commitHeredocBodyCommand,
  commitAfterUnrelatedSegmentCommand,
]) {
  test(`A Bash call carrying the commit invocation outside its own segment spends the direct tool budget: ${commitLookalikeCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Bash", "three", { command: commitLookalikeCommand }),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
  });

  test(`A Bash call carrying the commit invocation outside its own segment is denied once the budget is spent: ${commitLookalikeCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assert.match(
      assertDenied(
        payloadFor(transcriptPath, {
          tool_name: "Bash",
          tool_input: { command: commitLookalikeCommand },
        }),
      ),
      /budget/,
    );
  });
}

const wrappedCommitWorkflowCommands = [
  `cd /some/dir && ${commitLandCommand}`,
  `NODE_OPTIONS=--no-warnings node $HOME/.claude/skills/commit/land.ts`,
  "/usr/bin/node $HOME/.claude/skills/commit/land.ts",
];

for (const wrappedCommitWorkflowCommand of wrappedCommitWorkflowCommands) {
  test(`A wrapped commit workflow call is exempt once the budget is spent: ${wrappedCommitWorkflowCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assertAllowed(
      payloadFor(transcriptPath, {
        tool_name: "Bash",
        tool_input: { command: wrappedCommitWorkflowCommand },
      }),
    );
  });
}

const wrappedDispatchCommands = [
  "systemd-run --user --unit=codex-1 --setenv=HOME=/home/jwaters codex exec --full-auto < prompt.md",
  "timeout 1800 codex exec --full-auto task",
  "nohup codex exec --full-auto task",
  "XAI_API_KEY=x grok --prompt-file plan.md --always-approve",
  "systemd-run --user --unit=codex-2 bash -lc 'codex exec --full-auto < prompt.md > log 2>&1; echo exit=$? > done'",
  'bash -lc "grok --prompt-file plan.md"',
  "codex  exec --full-auto task",
];

for (const wrappedDispatchCommand of wrappedDispatchCommands) {
  test(`A wrapped dispatch is exempt once the budget is spent: ${wrappedDispatchCommand}`, () => {
    const transcriptPath = writeTranscript([
      userEntry(currentPromptId),
      assistantEntry([
        toolUse("Read", "one"),
        toolUse("Grep", "two"),
        toolUse("Edit", "three"),
      ]),
      toolResultEntry(currentPromptId),
    ]);

    assertAllowed(
      payloadFor(transcriptPath, {
        tool_name: "Bash",
        tool_input: { command: wrappedDispatchCommand },
      }),
    );
  });
}

test("A bare dispatch stays exempt once the budget is spent", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(
    payloadFor(transcriptPath, {
      tool_name: "Bash",
      tool_input: { command: "codex exec --full-auto task" },
    }),
  );
});

test("Siblings of a parallel batch recorded after the current call are not prior calls", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([toolUse("Read", "current-call")]),
    assistantEntry([toolUse("Read", "sibling-two")]),
    assistantEntry([toolUse("Read", "sibling-three")]),
    assistantEntry([toolUse("Read", "sibling-four")]),
  ]);

  assertAllowed(payloadFor(transcriptPath));

  const spentBudgetTranscriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
    assistantEntry([toolUse("Read", "current-call")]),
    assistantEntry([toolUse("Read", "sibling-two")]),
  ]);

  assert.match(assertDenied(payloadFor(spentBudgetTranscriptPath)), /3 prior calls/);
});

test("An injected teammate message without a prompt source does not restart the budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    injectedTeammateEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
});

test("A meta entry carrying the current prompt identifier does not restart the budget", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    skillLoadMetaEntry(currentPromptId),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /budget/);
});

test("A tool outside the direct work set is allowed once the budget is spent", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath, { tool_name: "Agent" }));
});

test("Assistant calls before the typed prompt do not spend the current budget", () => {
  const transcriptPath = writeTranscript([
    assistantEntry([
      toolUse("Read", "old-one"),
      toolUse("Edit", "old-two"),
      toolUse("Write", "old-three"),
    ]),
    userEntry(currentPromptId),
    assistantEntry([toolUse("Read", "one"), toolUse("Grep", "two")]),
    toolResultEntry(currentPromptId),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});

const scanCapPaddingText = "p".repeat(512 * 1024);
const scanCapPaddingEntryCount = 9;

function scanCapPaddingEntries() {
  return Array.from({ length: scanCapPaddingEntryCount }, () =>
    assistantEntry([{ type: "text", text: scanCapPaddingText }]),
  );
}

test("A turn larger than the transcript scan cap still denies the fourth direct tool call", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    ...scanCapPaddingEntries(),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    assistantEntry([toolUse("Read", "current-call")]),
  ]);

  assert.match(assertDenied(payloadFor(transcriptPath)), /3 prior calls/);
});

test("A turn larger than the transcript scan cap honors a commit Skill invocation before the current call", () => {
  const transcriptPath = writeTranscript([
    userEntry(currentPromptId),
    ...scanCapPaddingEntries(),
    assistantEntry([
      toolUse("Read", "one"),
      toolUse("Grep", "two"),
      toolUse("Edit", "three"),
    ]),
    assistantEntry([toolUse("Skill", "commit-skill", { skill: "commit" })]),
    assistantEntry([toolUse("Read", "current-call")]),
  ]);

  assertAllowed(payloadFor(transcriptPath));
});
