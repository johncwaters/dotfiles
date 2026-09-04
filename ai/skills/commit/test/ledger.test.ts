import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendParkedEntry,
  compactLedger,
  dropParkedEntries,
  entryKey,
  entryPathsAreAbsolute,
  ledgerPath,
  newestEntryPerBranch,
  parseLedger,
  supersededKeys,
  withLedgerLock,
  type ParkedEntry,
} from "../lib/ledger.ts";
import { cleanup, makeLedgerPath, parkedEntryFixture } from "./helpers.ts";

function parkedEntry(overrides: Partial<ParkedEntry> = {}): ParkedEntry {
  return parkedEntryFixture(overrides);
}

function writeLedgerLines(atPath: string, lines: string[]): void {
  fs.writeFileSync(atPath, `${lines.join("\n")}\n`, "utf8");
}

function droppedBranch(branch: string): (entry: ParkedEntry) => boolean {
  return (entry) => entry.branch === branch;
}

test("parseLedger separates supported entries from every other line", () => {
  const supported = parkedEntry();
  const unsupported = JSON.stringify({ ...supported, v: 2 });
  const parsed = parseLedger(`\n${JSON.stringify(supported)}\nnot json\n${unsupported}\n`);

  assert.deepEqual(parsed.entries, [supported]);
  assert.deepEqual(parsed.unrecognizedLines, ["not json", unsupported]);
});

test("appendParkedEntry round trips through parseLedger", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  try {
    assert.equal(appendParkedEntry(parkedEntry(), atPath), true);
    assert.deepEqual(parseLedger(fs.readFileSync(atPath, "utf8")).entries, [parkedEntry()]);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("compactLedger replaces a read-only ledger through rename", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  const survivor = parkedEntry({ branch: "survivor" });
  try {
    writeLedgerLines(atPath, [JSON.stringify(parkedEntry()), JSON.stringify(survivor)]);
    fs.chmodSync(atPath, 0o400);

    assert.equal(compactLedger(atPath, droppedBranch("feature")), true);

    assert.deepEqual(parseLedger(fs.readFileSync(atPath, "utf8")).entries, [survivor]);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("compactLedger carries unrecognized lines through unchanged", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  const foreign = JSON.stringify({ ...parkedEntry(), v: 2 });
  const survivor = parkedEntry({ branch: "survivor" });
  try {
    writeLedgerLines(atPath, [
      "not json",
      JSON.stringify(parkedEntry()),
      foreign,
      JSON.stringify(survivor),
    ]);

    assert.equal(compactLedger(atPath, droppedBranch("feature")), true);

    const written = fs.readFileSync(atPath, "utf8");
    assert.deepEqual(parseLedger(written).entries, [survivor]);
    assert.deepEqual(parseLedger(written).unrecognizedLines, ["not json", foreign]);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("withLedgerLock keeps a second holder out and releases the lock afterwards", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  try {
    const nested = withLedgerLock(atPath, () => withLedgerLock(atPath, () => "inner"));

    assert.equal(nested, null);
    assert.equal(fs.existsSync(`${atPath}.lock`), false);
    assert.equal(withLedgerLock(atPath, () => "after"), "after");
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("withLedgerLock takes over a lock left behind by a dead holder", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  const lockPath = `${atPath}.lock`;
  try {
    fs.writeFileSync(lockPath, "", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    assert.equal(withLedgerLock(atPath, () => "taken"), "taken");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("appendParkedEntry gives up while another holder keeps the lock", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  try {
    const appended = withLedgerLock(atPath, () => appendParkedEntry(parkedEntry(), atPath));

    assert.equal(appended, false);
    assert.equal(fs.existsSync(atPath), false);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("compactLedger gives up while another holder keeps the lock", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  const ledgerText = `${JSON.stringify(parkedEntry())}\n`;
  try {
    fs.writeFileSync(atPath, ledgerText, "utf8");

    const compacted = withLedgerLock(atPath, () =>
      compactLedger(atPath, droppedBranch("feature")),
    );

    assert.equal(compacted, false);
    assert.equal(fs.readFileSync(atPath, "utf8"), ledgerText);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("dropParkedEntries removes only the named repository and branch", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  const otherBranch = parkedEntry({ branch: "other" });
  const otherRepository = parkedEntry({ gitCommonDir: "/tmp/elsewhere/.git" });
  try {
    writeLedgerLines(atPath, [
      JSON.stringify(parkedEntry()),
      JSON.stringify(otherBranch),
      JSON.stringify(otherRepository),
      "not json",
    ]);

    assert.equal(dropParkedEntries({ gitCommonDir: "/tmp/repo/.git", branch: "feature" }, atPath), true);

    const parsed = parseLedger(fs.readFileSync(atPath, "utf8"));
    assert.deepEqual(parsed.entries, [otherBranch, otherRepository]);
    assert.deepEqual(parsed.unrecognizedLines, ["not json"]);
  } finally {
    cleanup(ledgerDirectory);
  }
});

test("dropParkedEntries leaves a ledger that was never written alone", () => {
  const { ledgerDirectory, ledgerPath: atPath } = makeLedgerPath();
  try {
    assert.equal(dropParkedEntries({ gitCommonDir: "/tmp/repo/.git", branch: "feature" }, atPath), true);

    assert.equal(fs.existsSync(atPath), false);
    assert.equal(fs.existsSync(`${atPath}.lock`), false);
  } finally {
    cleanup(ledgerDirectory);
  }
});

function restoreConfiguredLedgerPath(configuredPath: string | undefined): void {
  if (configuredPath === undefined) {
    delete process.env.CLAUDE_COMMIT_LEDGER;
    return;
  }
  process.env.CLAUDE_COMMIT_LEDGER = configuredPath;
}

test("ledgerPath falls back to the home ledger when the environment names a relative path", () => {
  const configuredPath = process.env.CLAUDE_COMMIT_LEDGER;
  try {
    process.env.CLAUDE_COMMIT_LEDGER = path.join("relative", "commit-ledger.jsonl");
    assert.equal(ledgerPath(), path.join(homedir(), ".claude", "commit-ledger.jsonl"));

    process.env.CLAUDE_COMMIT_LEDGER = path.join(homedir(), "absolute-ledger.jsonl");
    assert.equal(ledgerPath(), path.join(homedir(), "absolute-ledger.jsonl"));
  } finally {
    restoreConfiguredLedgerPath(configuredPath);
  }
});

test("entryPathsAreAbsolute rejects a relative repository or git directory", () => {
  assert.equal(entryPathsAreAbsolute(parkedEntry()), true);
  assert.equal(entryPathsAreAbsolute(parkedEntry({ repo: "repo" })), false);
  assert.equal(entryPathsAreAbsolute(parkedEntry({ gitCommonDir: ".git" })), false);
});

test("newestEntryPerBranch keeps the latest entry for each repository and branch", () => {
  const older = parkedEntry({ at: "2026-09-01T00:00:00.000Z", commit: "aaaaaaaaaaaaaaaa" });
  const newer = parkedEntry({ at: "2026-09-02T00:00:00.000Z", commit: "bbbbbbbbbbbbbbbb" });
  const otherBranch = parkedEntry({ branch: "other" });
  const otherRepository = parkedEntry({ gitCommonDir: "/tmp/elsewhere/.git" });

  const newest = newestEntryPerBranch([older, newer, otherBranch, otherRepository]);

  assert.deepEqual(Array.from(newest), [newer, otherBranch, otherRepository]);
});

test("newestEntryPerBranch treats an unparsable timestamp as the oldest", () => {
  const undated = parkedEntry({ at: "not a date", commit: "aaaaaaaaaaaaaaaa" });
  const dated = parkedEntry({ at: "1970-01-01T00:00:00.001Z", commit: "bbbbbbbbbbbbbbbb" });

  assert.deepEqual(Array.from(newestEntryPerBranch([undated, dated])), [dated]);
});

test("supersededKeys names every entry the newest set left behind", () => {
  const older = parkedEntry({ at: "2026-09-01T00:00:00.000Z", commit: "aaaaaaaaaaaaaaaa" });
  const newer = parkedEntry({ at: "2026-09-02T00:00:00.000Z", commit: "bbbbbbbbbbbbbbbb" });
  const entries = [older, newer];

  const superseded = supersededKeys(entries, newestEntryPerBranch(entries));

  assert.deepEqual(Array.from(superseded), [entryKey(older)]);
});

test("supersededKeys spares a duplicate line of the entry it kept", () => {
  const kept = parkedEntry();
  const duplicate = parkedEntry();
  const entries = [kept, duplicate];

  const superseded = supersededKeys(entries, new Set([kept]));

  assert.equal(superseded.size, 0);
});
