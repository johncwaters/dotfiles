import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "./harness.mjs";

function writePayload(extension, content) {
  return { tool_name: "Write", tool_input: { file_path: `/nonexistent/form${extension}`, content } };
}

function decisionFor(payload) {
  const hookProcess = runHook("block-button-labels.mjs", payload);
  if (hookProcess.stdout === "") return { decision: "allow", reason: "" };
  const output = JSON.parse(hookProcess.stdout).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
}

test("a button whose label carries state is denied in every markup flavor", () => {
  const statefulButtons = [
    [".tsx", '<button disabled={isSaving}>{isSaving ? "Saving..." : "Save"}</button>', "progress word"],
    [".tsx", "<Button onClick={commit}>Analyzing…</Button>", "progress word"],
    [".jsx", "<LemonButton>{isOpen ? 'Hide' : 'Run'}</LemonButton>", "label ternary"],
    [".tsx", "<button>List {cards.length} cards</button>", "count"],
    [".tsx", "<Button>Open {selectedCount}</Button>", "count"],
    [".tsx", "<button type=\"submit\">\n  <Spinner size=\"sm\" />\n  Commit\n</button>", "spinner"],
    [".html", '<button class="btn"><svg class="animate-spin"></svg>Commit</button>', "spinner"],
    [".vue", "<button @click=\"save\">{{ saving ? 'Saving' : 'Save' }}</button>", "progress word"],
    [".svelte", "<div role=\"button\" on:click={run}>{done ? 'Run again' : 'Run'}</div>", "label ternary"],
    [".tsx", "<LemonButton icon={<Spinner />}>Save</LemonButton>", "spinner"],
    [".tsx", "<LemonButton disabled={count < 1} onClick={() => save()}>Saving...</LemonButton>", "progress word"],
    [".vue", "<el-button :loading=\"saving\">Saving...</el-button>", "progress word"],
    [".vue", "<v-btn><v-progress-circular indeterminate />Save</v-btn>", "spinner"],
    [".tsx", "<Button label={isSaving ? \"Saving...\" : \"Save\"} />", "progress word"],
    [".tsx", `<button><svg><path d="${"M0 0 ".repeat(600)}" /></svg>Uploading...</button>`, "progress word"],
  ];
  for (const [extension, markup, reason] of statefulButtons) {
    const { decision, reason: denial } = decisionFor(writePayload(extension, markup));
    assert.equal(decision, "deny", markup);
    assert.match(denial, new RegExp(reason), markup);
  }
});

test("constant labels, status beside the button, and non-markup files pass", () => {
  const passingWrites = [
    [".tsx", "<button disabled={isSaving}>Save</button>{isSaving && <Spinner />}"],
    [".tsx", "<Button onClick={commit}>Commit</Button><span>{cards.length} cards</span>"],
    [".tsx", "<button aria-expanded={isOpen}>Details</button>"],
    [".tsx", "<button>Save as…</button>"],
    [".tsx", "<Button icon={<IconPlus />}>Add card</Button>"],
    [".tsx", "<OSButton onClick={() => goToPage(page)} className={page === currentPage ? 'font-bold' : ''}>{page + 1}</OSButton>"],
    [".tsx", "<button disabled={items.length === 0}>Export</button>"],
    [".tsx", "<button><Icon className={isOpen ? 'rotate-90' : ''} />Details</button>"],
    [".tsx", "const ordered = sortBy<Item>(items, 'name'); const ok = a < b && c > d;"],
    [".ts", 'const label = "<button>Saving...</button>";'],
    [".md", "<button>Loading...</button>"],
  ];
  for (const [extension, markup] of passingWrites) {
    assert.equal(decisionFor(writePayload(extension, markup)).decision, "allow", markup);
  }
});

test("a large file of role=button attributes scans in linear time", () => {
  const manyRoleAttributes = "<a" + ' role="button"'.repeat(200000) + ">Open</a>";
  const startedAt = Date.now();
  assert.equal(decisionFor(writePayload(".html", manyRoleAttributes)).decision, "allow");
  assert.ok(Date.now() - startedAt < 5000, `took ${Date.now() - startedAt} ms`);
});

test("an edit to a file with an existing stateful button passes when it adds none", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "block-button-labels-"));
  const filePath = path.join(directory, "form.tsx");
  fs.writeFileSync(filePath, '<button>{isSaving ? "Saving" : "Save"}</button>\nconst greeting = "hi";\n');
  const editPayload = (newString) => ({ tool_name: "Edit", tool_input: { file_path: filePath, old_string: 'const greeting = "hi";', new_string: newString } });
  assert.equal(decisionFor(editPayload('const greeting = "hello";')).decision, "allow");
  assert.equal(decisionFor(editPayload("<Button>Uploading...</Button>")).decision, "deny");
  fs.rmSync(directory, { recursive: true, force: true });
});
