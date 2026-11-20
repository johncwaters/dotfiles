import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeOwnedRepository, runHook } from "./harness.mjs";

const ownedRepository = makeOwnedRepository("block-vague-names-owned-");

function decisionOf(filePath, content) {
  const hookProcess = runHook("block-vague-names.mjs", { tool_name: "Write", tool_input: { file_path: filePath, content } });
  assert.equal(hookProcess.status, 0);
  if (!hookProcess.stdout) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(hookProcess.stdout).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

test("vague and single-letter bindings in an owned repo are denied in JavaScript, TypeScript and Python", () => {
  const vagueWrites = [
    ["load.ts", "const data = fetchInvoices();"],
    ["load.js", "function parse(tmp, count) { return count; }"],
    ["load.ts", "invoices.map((x) => x.total);"],
    ["load.js", "try { run(); } catch (e) { report(); }"],
    ["load.ts", "for (let k = 0; k < rows.length; k++) {}"],
    ["load.py", "result = fetch_invoices()"],
    ["load.py", "def parse(self, res):\n    return res"],
    ["load.py", "for x in invoices:\n    print(x)"],
    ["load.ts", "export function loadInvoices(\n  data: string,\n  count: number,\n) {}"],
    ["load.py", "def load_invoices(\n    tmp,\n):\n    pass"],
    ["load.ts", "const unpaidInvoices = 1, data = 2;"],
    ["load.py", "try:\n    run()\nexcept ValueError as e:\n    pass"],
    ["load.py", "with open(path) as f:\n    pass"],
    ["load.py", "if (data := fetch()):\n    pass"],
  ];
  for (const [fileName, content] of vagueWrites) {
    const { decision, reason } = decisionOf(path.join(ownedRepository, fileName), content);
    assert.equal(decision, "deny", content);
    assert.match(reason, /Naming guard/);
  }
});

test("domain names, loop counters, destructuring, strings and keyword arguments pass", () => {
  const namedWrites = [
    ["load.ts", "const unpaidInvoices = fetchInvoices();"],
    ["load.ts", "for (let i = 0; i < rows.length; i++) { for (let j = 0; j < i; j++) {} }"],
    ["load.ts", "const { data } = await client.get(url);"],
    ["load.ts", "const render = ({ data }: Props) => data.title;"],
    ["load.ts", "const label = \"const data = 1\";"],
    ["load.ts", "if (isReady) { start(); }"],
    ["load.py", "for i in range(rows):\n    send(payload=rows[i], data=None)"],
    ["load.py", "response = requests.post(\n    invoice_url,\n    data=encoded_invoice,\n)"],
    ["load.md", "const data = 1;"],
  ];
  for (const [fileName, content] of namedWrites) {
    assert.equal(decisionOf(path.join(ownedRepository, fileName), content).decision, "allow", content);
  }
});

test("a vague name kept by an edit, or added in a repo the carbon unit does not own, passes", () => {
  const keptName = runHook("block-vague-names.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: path.join(ownedRepository, "missing.ts"), old_string: "const data = load(a);", new_string: "const data = load(b);" },
  });
  assert.equal(keptName.stdout, "");
  const foreignRepository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "block-vague-names-foreign-")));
  assert.equal(decisionOf(path.join(foreignRepository, "load.ts"), "const data = load();").decision, "allow");
});

test("an agy write adding a vague name to an owned repo is denied in agy's reply shape", () => {
  const agyWrite = runHook("block-vague-names.mjs", {
    hookEventName: "PreToolUse",
    conversationId: "agy-conversation",
    toolCall: { name: "write_file", args: { Path: path.join(ownedRepository, "load.ts"), Content: "const tmp = 1;" } },
  }, {}, process.cwd(), ["--agent=agy"]);
  assert.equal(JSON.parse(agyWrite.stdout).decision, "deny");
});
