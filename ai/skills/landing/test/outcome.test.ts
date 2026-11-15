import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchForbidden,
  committed,
  denylistedFileStaged,
  detachedHead,
  EXIT_CODES,
  hookFailed,
  mainlineUnverified,
  messageInvalid,
  messageValid,
  notARepo,
  nothingToCommit,
  operationInProgress,
  promoteConflict,
  promoteFailed,
  pushFailed,
  ready,
  type Result,
} from "../lib/outcome.ts";

function roundTrip(result: Result): Record<string, unknown> {
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

test("every outcome constructor round-trips through JSON", () => {
  const results: Result[] = [
    ready({ branch: "feature", branchAllowed: true, changed: ["a.ts"], untracked: [], hasUncommittedWork: true }),
    committed({ commit: "abc123", branchPushed: true, promoted: ["main"] }),
    notARepo({}),
    detachedHead({}),
    operationInProgress({ operation: "MERGE_HEAD" }),
    nothingToCommit({ branchPushed: false, promoted: [] }),
    messageValid({}),
    messageInvalid({ errors: ["description must not be empty"] }),
    hookFailed({ warnings: ["pre-commit hook failed"] }),
    denylistedFileStaged({ files: [".env"] }),
    pushFailed({ commit: "abc123", branchPushed: false, promoted: [] }),
    promoteConflict({ commit: "abc123", branchPushed: false, promoted: [], conflicts: ["a.ts"] }),
    promoteFailed({ commit: "abc123", branchPushed: true, promoted: [] }),
    branchForbidden({ branch: "main" }),
    mainlineUnverified({
      commit: "abc123",
      branchPushed: true,
      promoted: [],
      mainline: "main",
    }),
  ];

  for (const result of results) {
    assert.deepEqual(roundTrip(result), result);
    assert.ok(result.outcome in EXIT_CODES);
  }
});

test("empty warnings are omitted and non-empty warnings survive", () => {
  assert.equal("warnings" in committed({ commit: "a", branchPushed: true, promoted: [] }), false);
  assert.deepEqual(
    committed({ commit: "a", branchPushed: true, promoted: [], warnings: ["no origin remote configured; skipping push"] })
      .warnings,
    ["no origin remote configured; skipping push"],
  );
});

test("a missing required field throws instead of reaching stdout", () => {
  assert.throws(
    () => committed({ branchPushed: true, promoted: [] } as unknown as { commit: string; branchPushed: boolean; promoted: string[] }),
    /missing required field commit/,
  );
});

test("a field of the wrong type throws instead of reaching stdout", () => {
  assert.throws(
    () =>
      committed({ commit: "abc", branchPushed: "yes", promoted: [] } as unknown as {
        commit: string;
        branchPushed: boolean;
        promoted: string[];
      }),
    /field branchPushed must be a boolean/,
  );
});

test("an unknown field throws instead of reaching stdout", () => {
  assert.throws(
    () =>
      committed({ commit: "abc", branchPushed: true, promoted: [], findings: [] } as unknown as {
        commit: string;
        branchPushed: boolean;
        promoted: string[];
      }),
    /has no field named findings/,
  );
});
