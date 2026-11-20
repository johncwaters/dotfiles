import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { runHook } from "./harness.mjs";

const ownedRepository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-owned-")));
spawnSync("git", ["init", "-q", ownedRepository]);
spawnSync("git", ["-C", ownedRepository, "remote", "add", "origin", "https://github.com/carbon-unit/owned.git"]);
const ownedListPath = `${ownedRepository}-owned-repos.txt`;
fs.writeFileSync(ownedListPath, "github.com/carbon-unit/owned\n");
process.env.DOTFILES_OWNED_REPOS_FILE = ownedListPath;

function canRead(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

test("a write adding a comment line to a code file is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: `${ownedRepository}/a.js`, content: "// increment counter\nconst x = 1;\n" },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /No-comments guard/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /increment counter/);
});

const allowedJavaScriptWriteScenarios = [
  {
    name: "a comment-free write is allowed",
    content: "const x = 1;\n",
  },
  {
    name: "a jsdoc type tag block is exempt from the comment guard",
    content: "/**\n * @param {number} n\n */\nfunction f(n) { return n; }\n",
  },
];

for (const scenario of allowedJavaScriptWriteScenarios) {
  test(scenario.name, () => {
    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: `${ownedRepository}/a.js`, content: scenario.content },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  });
}

test("an edit that only moves an existing comment is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: `${ownedRepository}/a.ts`,
      old_string: "// keep this note\nconst a = 1;",
      new_string: "const a = 2;\n// keep this note",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("an edit introducing a hash comment in python is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: `${ownedRepository}/a.py`,
      old_string: "x = 1",
      new_string: "# loop over users\nx = 1",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("the comment guard ignores non-code files and bad payloads", () => {
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/n/a.md", content: "# heading\ntext" } },
    { tool_name: "Bash", tool_input: { command: "echo // hi" } },
    { tool_name: "Write", tool_input: {} },
  ]) {
    const processResult = runHook("block-comments.mjs", payload);
    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  }
});

const allowedLiteralCommentScenarios = [
  {
    name: "a shebang line does not count as a comment",
    filePath: `${ownedRepository}/run.sh`,
    content: "#!/bin/sh\nset -e\n",
  },
  {
    name: "a shell heredoc body carrying a hash line is allowed",
    filePath: `${ownedRepository}/gen.sh`,
    content: "cat <<'EOF'\n# generated file\nEOF\n",
  },
  {
    name: "a python docstring carrying a hash line is allowed",
    filePath: `${ownedRepository}/a.py`,
    content: 'def f():\n    """\n    # Usage: f()\n    """\n    return 1\n',
  },
  {
    name: "a template literal carrying a slash line is allowed",
    filePath: `${ownedRepository}/a.js`,
    content: "const banner = `\n// not a comment\n`;\n",
  },
];

for (const scenario of allowedLiteralCommentScenarios) {
  test(scenario.name, () => {
    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: scenario.filePath, content: scenario.content },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  });
}

test("a write to an unreadable existing file is allowed", (testContext) => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "a.js");
  const content = "// existing note\nconst a = 1;\n";
  try {
    fs.writeFileSync(filePath, content, "utf8");
    fs.chmodSync(filePath, 0o000);
    if (canRead(filePath)) {
      testContext.skip("this account reads a mode 000 file");
      return;
    }

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.chmodSync(filePath, 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prose block comment holding an email address is denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/a.js`,
      content: "/**\n * ping alice@example.com before touching this\n */\nconst a = 1;\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /alice@example\.com/);
});

test("the deny reason names only the comment the edit adds", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Edit",
    tool_input: {
      file_path: `${ownedRepository}/a.js`,
      old_string: "// keep a\n// keep b\nconst a = 1;",
      new_string: "// keep a\n// keep b\n// brand new\nconst a = 1;",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /brand new/);
  assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /keep a/);
});

const deniedQuotedDelimiterScenarios = [
  {
    name: "a shell left shift does not open a heredoc region",
    filePath: `${ownedRepository}/shift.sh`,
    content: "mask=$(( 1 << 3 ))\n# explain the mask\n",
    expectedComment: /explain the mask/,
  },
  {
    name: "a herestring does not open a heredoc region",
    filePath: `${ownedRepository}/here.sh`,
    content: "cat <<< hello\n# explain the greeting\n",
    expectedComment: /explain the greeting/,
  },
  {
    name: "a backtick inside a quoted string does not open a template literal",
    filePath: `${ownedRepository}/quote.js`,
    content: 'const fence = "`";\n// explain the fence\n',
    expectedComment: /explain the fence/,
  },
  {
    name: "a triple quote inside a quoted string does not open a docstring",
    filePath: `${ownedRepository}/quote.py`,
    content: "token = \"'''\"\n# explain the token\n",
    expectedComment: /explain the token/,
  },
];

for (const scenario of deniedQuotedDelimiterScenarios) {
  test(scenario.name, () => {
    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: scenario.filePath, content: scenario.content },
    });

    assert.equal(processResult.status, 0);
    const output = JSON.parse(processResult.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, scenario.expectedComment);
  });
}

test("an edit inside a heredoc body of an on-disk file is allowed", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "gen.sh");
  try {
    fs.writeFileSync(filePath, "cat <<'EOF'\nintro line\nEOF\nrun_it\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: {
        file_path: filePath,
        old_string: "intro line",
        new_string: "intro line\n# generated by hand",
      },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an edit outside the heredoc body of an on-disk file is denied", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "gen.sh");
  try {
    fs.writeFileSync(filePath, "cat <<'EOF'\nintro line\nEOF\nrun_it\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: {
        file_path: filePath,
        old_string: "run_it",
        new_string: "# explain the run\nrun_it",
      },
    });

    assert.equal(processResult.status, 0);
    const output = JSON.parse(processResult.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the run/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a yaml block scalar carrying a hash line is not gated", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/workflow.yml`,
      content: "jobs:\n  build:\n    run: |\n      # release notes\n      make all\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("a long whitespace run in a block comment is judged quickly", () => {
  const content = `/**\n${" ".repeat(20000)}prose about the module\n */\nconst a = 1;\n`;
  const startedAt = performance.now();
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: `${ownedRepository}/slow.js`, content },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(elapsedMs < 500, `hook took ${elapsedMs}ms`);
});

test("an apostrophe inside a template literal does not hide later comments", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/message.js`,
      content: "const msg = `Can't find ${name}`;\n// brand new note\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /brand new note/);
});

test("deleting a template literal line above existing comments is allowed", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "message.js");
  const templateLine = "const msg = `Can't find ${name}`;\n";
  try {
    fs.writeFileSync(filePath, `${templateLine}// one\n// two\n// three\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: templateLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a shift operator inside a quoted string does not open a heredoc", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "echo.sh");
  const echoLine = 'echo "use << HERE for input"\n';
  try {
    fs.writeFileSync(filePath, `${echoLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: echoLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const allowedHeredocScenarios = [
  {
    name: "a backslash-escaped heredoc delimiter opens a body",
    filePath: `${ownedRepository}/gen.sh`,
    content: "cat <<\\EOF\n# generated file\nEOF\n",
  },
  {
    name: "two heredocs opened on one line both keep their bodies out of the count",
    filePath: `${ownedRepository}/pair.sh`,
    content: "cat <<FIRST <<SECOND\nFIRST\n# second body\nSECOND\n",
  },
];

for (const scenario of allowedHeredocScenarios) {
  test(scenario.name, () => {
    const processResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: scenario.filePath, content: scenario.content },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  });
}

test("a backtick in a trailing comment does not open a template literal", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/tail.js`,
      content: "const count = 1; // `\n// explain the count\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the count/);
});

test("an escaped triple quote does not close a docstring", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/doc.py`,
      content: 'x = """\n\\"""\n# still text\n"""\n',
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("the deny reason omits an on-disk line the call never supplied", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "settings.py");
  try {
    fs.writeFileSync(filePath, "x = 1\nSECRET = 1\n", "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: "\n", new_string: "\n#" },
    });

    assert.equal(processResult.status, 0);
    const output = JSON.parse(processResult.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /1 net-new comment line/);
    assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /SECRET/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deleting a line whose trailing comment names a heredoc opener is allowed", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "echo.sh");
  const callLine = "run_it # see << HERE\n";
  try {
    fs.writeFileSync(filePath, `${callLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: callLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a heredoc opener inside a trailing shell comment does not hide a new comment", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/tail.sh`,
      content: "echo ok # <<EOF\n# explain the echo\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the echo/);
});

test("a positional parameter count still opens a heredoc region", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/args.sh`,
      content: "[ $# -gt 0 ] && cat <<EOF\n# generated file\nEOF\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("deleting a line whose trailing comment holds a triple quote is allowed", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "settings.py");
  const assignmentLine = 'x = 1  # use """ here\n';
  try {
    fs.writeFileSync(filePath, `${assignmentLine}# one\n# two\n`, "utf8");

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: assignmentLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a triple quote inside a trailing python comment does not open a docstring", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/tail.py`,
      content: "value = 1 # '''\n# explain the value\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the value/);
});

test("deleting a tag line from a jsdoc block is allowed", () => {
  const directory = fs.mkdtempSync(path.join(ownedRepository, "block-comments-hook-"));
  const filePath = path.join(directory, "doc.js");
  const tagLine = " * @param {number} n\n";
  try {
    fs.writeFileSync(
      filePath,
      `/**\n * describes f\n${tagLine} */\nfunction f(n) { return n; }\n`,
      "utf8",
    );

    const processResult = runHook("block-comments.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: tagLine, new_string: "" },
    });

    assert.equal(processResult.status, 0);
    assert.equal(processResult.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a single-line jsdoc type cast is allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/cast.js`,
      content: "/** @type {Foo} */\nconst a = load();\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("tool pragma lines are allowed", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/pragma.test.tsx`,
      content:
        "// @vitest-environment happy-dom\n/** @jsxImportSource preact */\n/**\n * @jest-environment jsdom\n */\nconst a = 1;\n",
    },
  });

  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "");
});

test("prose after a tool pragma and silencing directives are denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/smuggle.ts`,
      content: "// @vitest-environment happy-dom because the dom is needed\n// @ts-ignore\nconst a = 1;\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /2 net-new comment line/);

  const joinedProsePragmas = [
    ["retry.go", "// @jsx retries-three-times-because-the-upstream-api-flakes-under-load-see-INC-4521"],
    ["cache.ts", "// @jsxImportSource do-not-remove:this-cache-must-be-cleared-before-every-request"],
    ["ledger.rs", "// @jsxFrag keep.this.loop.sequential.or.the.ledger.double-charges"],
  ];
  for (const [fileName, pragmaLine] of joinedProsePragmas) {
    const joinedProseResult = runHook("block-comments.mjs", {
      tool_name: "Write",
      tool_input: { file_path: `${ownedRepository}/${fileName}`, content: `${pragmaLine}\nconst a = 1;\n` },
    });

    assert.equal(joinedProseResult.status, 0);
    assert.equal(JSON.parse(joinedProseResult.stdout).hookSpecificOutput.permissionDecision, "deny", fileName);
  }
});

test("prose lines in a tagged jsdoc block are denied", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/prose.js`,
      content:
        "/**\n * @param {number} n\n * smuggled prose one\n * smuggled prose two\n */\nfunction f(n) { return n; }\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /2 net-new comment line/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /smuggled prose one/);
});

test("a backtick inside a same-line block comment does not open a template literal", () => {
  const processResult = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: {
      file_path: `${ownedRepository}/inline.js`,
      content: "const count = 1; /* ` */\n// explain the count\n",
    },
  });

  assert.equal(processResult.status, 0);
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /explain the count/);
});

test("a comment added to a repo the carbon unit does not own passes, while agy's write to an owned repo is denied", () => {
  const foreignRepository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "block-comments-foreign-")));
  spawnSync("git", ["init", "-q", foreignRepository]);
  spawnSync("git", ["-C", foreignRepository, "remote", "add", "origin", "https://github.com/someone-else/library.git"]);
  const foreignWrite = runHook("block-comments.mjs", {
    tool_name: "Write",
    tool_input: { file_path: path.join(foreignRepository, "a.js"), content: "// upstream keeps comments\nconst x = 1;\n" },
  });
  assert.equal(foreignWrite.stdout, "");
  const agyOwnedWrite = runHook("block-comments.mjs", {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: { name: "write_file", args: { Path: path.join(ownedRepository, "a.js"), Content: "// increment counter\nconst x = 1;\n" } },
  }, {}, process.cwd(), ["--agent=agy"]);
  assert.equal(JSON.parse(agyOwnedWrite.stdout).decision, "deny");
});
