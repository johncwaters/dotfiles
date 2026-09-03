import assert from "node:assert/strict";
import { test } from "node:test";
import { isPatchEquivalentMerged } from "../lib/merge-proof.ts";

test("isPatchEquivalentMerged rejects empty output", () => {
  assert.equal(isPatchEquivalentMerged(""), false);
});

test("isPatchEquivalentMerged accepts only equivalent patches", () => {
  assert.equal(isPatchEquivalentMerged("- abc123\n- def456\n"), true);
});

test("isPatchEquivalentMerged rejects a new patch", () => {
  assert.equal(isPatchEquivalentMerged("+ abc123\n"), false);
});

test("isPatchEquivalentMerged rejects mixed patch status", () => {
  assert.equal(isPatchEquivalentMerged("- abc123\n+ def456\n"), false);
});

test("isPatchEquivalentMerged rejects garbage status", () => {
  assert.equal(isPatchEquivalentMerged("? abc123\n"), false);
});

test("isPatchEquivalentMerged ignores trailing blank lines", () => {
  assert.equal(isPatchEquivalentMerged("- abc123\n\n \n"), true);
});
