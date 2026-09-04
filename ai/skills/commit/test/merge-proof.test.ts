import assert from "node:assert/strict";
import { test } from "node:test";
import { isTreeContained } from "../lib/merge-proof.ts";

const SHA1_TREE_OID = "0123456789abcdef0123456789abcdef01234567";
const SHA256_TREE_OID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("isTreeContained accepts an exact 40-hex tree match", () => {
  assert.equal(isTreeContained(`\n ${SHA1_TREE_OID}\n`, SHA1_TREE_OID), true);
});

test("isTreeContained rejects a different tree", () => {
  assert.equal(isTreeContained(`${SHA1_TREE_OID}\n`, `${SHA1_TREE_OID.slice(0, -1)}8`), false);
});

test("isTreeContained rejects empty output", () => {
  assert.equal(isTreeContained("\n \n", SHA1_TREE_OID), false);
});

test("isTreeContained rejects garbage output", () => {
  assert.equal(isTreeContained("not a tree\n", SHA1_TREE_OID), false);
});

test("isTreeContained accepts an exact 64-hex tree match", () => {
  assert.equal(isTreeContained(`${SHA256_TREE_OID}\n`, SHA256_TREE_OID), true);
});
