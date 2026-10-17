import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionDigest } from "../lib/digest.ts";

const scriptPath = join(import.meta.dirname, "../digest.ts");
const fixturesDir = join(import.meta.dirname, "fixtures");
const fixturePath = join(fixturesDir, "synthetic-project/synthetic-session.jsonl");

test("CLI reduces a synthetic session to ordered incidents without counting metadata as prompts", (context) => {
  const projectsDir = mkdtempSync(join(tmpdir(), "retro-digest-"));
  context.after(() => rmSync(projectsDir, { recursive: true, force: true }));
  const projectDir = join(projectsDir, "synthetic-project");
  mkdirSync(projectDir);
  const transcript = readFileSync(fixturePath, "utf8")
    .replace('"OVERSIZED_TOOL_RESULT"', JSON.stringify("x".repeat(60000)));
  writeFileSync(join(projectDir, "synthetic-session.jsonl"), transcript);
  const digestProcess = spawnSync(process.execPath, [
    scriptPath, "synthetic-session", "--no-git", "--projects-dir", projectsDir,
  ], { encoding: "utf8", timeout: 5000 });
  equal(digestProcess.status, 0, digestProcess.stderr);
  const digest = JSON.parse(digestProcess.stdout) as SessionDigest;
  deepEqual(digest.counts, {
    correction: 2, interrupt: 1, "permission-denial": 1, "hook-denial": 1,
    "tool-error": 4, "repeated-failure": 1, "review-rework": 2, compaction: 1,
    "costly-subagent": 1, "oversized-result": 2, revert: 0,
  });
  deepEqual(digest.incidents.filter((incident) => incident.kind === "correction")
    .map((incident) => ({ line: incident.line, explicit: incident.explicit })), [
    { line: 4, explicit: true }, { line: 6, explicit: true },
  ]);
  equal(digest.malformedLineCount, 1);
  equal(digest.promptCount, 4);
  equal(digest.lineCount, 27);
  equal(digest.sessionId, "synthetic-session");
  equal(digest.startedAt, "2026-10-01T10:00:00Z");
  equal(digest.endedAt, "2026-10-01T10:05:00Z");
  const repeatedFailure = digest.incidents.find((incident) => incident.kind === "repeated-failure");
  equal(repeatedFailure?.line, 10);
  equal(repeatedFailure?.count, 3);
  equal(digest.incidents.find((incident) => incident.kind === "hook-denial")?.toolName, "PreToolUse:Bash");
  ok(digest.incidents.every((incident) => incident.excerpt.length <= 160 && !/[\r\n]/.test(incident.excerpt)));
  deepEqual(digest.incidents.map((incident) => incident.line), digest.incidents.map((incident) => incident.line).sort((first, second) => first - second));
});

test("CLI since selection uses file mtime, excludes subagents, and sorts sessions oldest first", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "retro-digest-"));
  try {
    const projectDir = join(projectsDir, "project");
    const subagentsDir = join(projectDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    for (const [relativePath, modifiedAt] of [
      ["project/old.jsonl", "2026-09-01"],
      ["project/later.jsonl", "2026-10-03"],
      ["project/earlier.jsonl", "2026-10-02"],
      ["project/subagents/child.jsonl", "2026-10-04"],
    ]) {
      if (!relativePath || !modifiedAt) throw new Error("Missing fixture path or date");
      const transcriptPath = join(projectsDir, relativePath);
      copyFileSync(fixturePath, transcriptPath);
      utimesSync(transcriptPath, new Date(modifiedAt), new Date(modifiedAt));
    }
    const digestProcess = spawnSync(process.execPath, [
      scriptPath, "--since", "2026-10-01", "--no-git", "--projects-dir", projectsDir,
    ], { encoding: "utf8", timeout: 5000 });
    equal(digestProcess.status, 0, digestProcess.stderr);
    const digests = JSON.parse(digestProcess.stdout) as SessionDigest[];
    deepEqual(digests.map((digest) => digest.transcriptPath), [
      join(projectDir, "earlier.jsonl"), join(projectDir, "later.jsonl"),
    ]);
    ok(digests.every((digest) => digest.promptCount === 4));
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
});
