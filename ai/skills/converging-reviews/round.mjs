#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  changedLineRanges,
  FIELD_SEPARATOR,
  fieldValue,
  isWithinRanges,
  parseFinding,
  runGit,
} from "../../hooks/check-finding-scope.mjs";

const EXIT_CODE_BY_OUTCOME = {
  FRESH: 0,
  RESUME: 0,
  RECORDED: 0,
  VERIFIED: 0,
  UNVERIFIED: 24,
  CLEAN: 0,
  CONTINUE: 10,
  RETRY: 11,
  ASKED: 20,
  STALLED: 21,
  CAPPED: 22,
  FAILED: 23,
  USAGE: 2,
};
const ROUND_CAP = 8;
const HUNK_SLACK_LINES = 3;
const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const FIX_OUTCOMES = new Set(["FIXED", "UNVERIFIED", "DECLINED"]);
const RULINGS = new Set(["NIT", "ACTIONABLE"]);
const VERDICTS = new Set(["APPROVE", "APPROVE WITH NITS", "REQUEST CHANGES", "BLOCKED", "FAILED"]);
const DISPOSITIONS = new Set(["ACTIONABLE", "NIT", "AMBIGUOUS"]);
const CITED_FILE_LINE = /([\w.@/-]+\.[\w]+):(\d+)/g;

function finish(outcome, details = {}) {
  process.stdout.write(`${JSON.stringify({ outcome, ...details })}\n`);
  process.exit(EXIT_CODE_BY_OUTCOME[outcome]);
}

function failUsage(message) {
  finish("USAGE", { error: message });
}

function mainCheckoutName(repoPath) {
  const commonDirectory = runGit(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return path.basename(path.dirname(commonDirectory));
}

function currentBranch(repoPath) {
  const branchName = runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  return branchName.replaceAll("/", "__");
}

function ledgerDirectory(repoPath) {
  const baseDirectory = process.env.CONVERGING_REVIEWS_DIR || path.join(os.homedir(), ".claude", "converging-reviews");
  return path.join(baseDirectory, mainCheckoutName(repoPath));
}

function ledgerPath(repoPath) {
  return path.join(ledgerDirectory(repoPath), `${currentBranch(repoPath)}.jsonl`);
}

function readLedger(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) return [];
  return fs
    .readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function appendRows(ledgerFile, rows) {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function roundRows(ledger) {
  return ledger.filter((row) => row.type === "round");
}

function startRun(repoPath, workingTree) {
  const ledgerFile = ledgerPath(repoPath);
  const lastRound = roundRows(readLedger(ledgerFile)).at(-1);
  if (lastRound?.outcome === "ASKED" && lastRound.head === workingTree) {
    finish("RESUME", { round: lastRound.round, base: lastRound.base, head: lastRound.head, ledger: ledgerFile });
  }
  if (fs.existsSync(ledgerFile)) {
    const setAsidePath = ledgerFile.replace(/\.jsonl$/, `.${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
    fs.renameSync(ledgerFile, setAsidePath);
  }
  const headTree = runGit(repoPath, ["rev-parse", "HEAD^{tree}"]).trim();
  finish("FRESH", { round: 1, base: headTree, ledger: ledgerFile });
}

function pinWorkingTree(repoPath) {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "converging-reviews-"));
  const indexCopy = path.join(scratchDirectory, "index");
  try {
    const liveIndex = path.resolve(repoPath, runGit(repoPath, ["rev-parse", "--git-path", "index"]).trim());
    if (fs.existsSync(liveIndex)) fs.copyFileSync(liveIndex, indexCopy);
    const gitWithIndexCopy = (argumentList) => spawnSync("git", argumentList, { cwd: repoPath, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: indexCopy } });
    const addResult = gitWithIndexCopy(["add", "-A"]);
    if (addResult.status !== 0) throw new Error(addResult.stderr || "git add -A failed");
    const writeTreeResult = gitWithIndexCopy(["write-tree"]);
    if (writeTreeResult.status !== 0) throw new Error(writeTreeResult.stderr || "git write-tree failed");
    return writeTreeResult.stdout.trim();
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function verifyCleanTree(repoPath) {
  const workingTree = pinWorkingTree(repoPath);
  const ledgerFile = ledgerPath(repoPath);
  const lastRound = roundRows(readLedger(ledgerFile)).at(-1);
  const isCleanOnThisTree = lastRound?.outcome === "CLEAN" && lastRound.head === workingTree;
  finish(isCleanOnThisTree ? "VERIFIED" : "UNVERIFIED", { tree: workingTree, lastRound: lastRound ?? null, ledger: ledgerFile });
}

function defectSentence(body) {
  const beforeProof = body.split(/\bProof:/)[0];
  const firstSentence = beforeProof.split(/(?<=[.!?])\s/)[0];
  return firstSentence
    .toLowerCase()
    .replace(/`[^`]*`|"[^"]*"|'[^']*'/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintOf(file, body) {
  return createHash("sha1").update(`${file}\n${defectSentence(body)}`).digest("hex").slice(0, 12);
}

function parseReview(reviewText) {
  const lines = reviewText.split(/\r?\n/);
  const headerValue = (label) => lines.find((line) => line.startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? "";
  const truncatedText = headerValue("TRUNCATED");
  const truncatedLanes = truncatedText === "" || truncatedText.toLowerCase() === "none" ? [] : truncatedText.split(/,\s*/);
  const blockStart = lines.findIndex((line) => line.trim() === "STRUCTURED_FINDINGS:");
  const blockEnd = lines.findIndex((line) => line.trim() === "OVERALL_SUMMARY:");
  const findingLines = blockStart === -1 ? [] : lines.slice(blockStart + 1, blockEnd === -1 ? undefined : blockEnd);
  const findings = findingLines.flatMap((line) => {
    const anchor = parseFinding(line);
    if (anchor === null) return [];
    const fields = line.trim().slice(1).split(FIELD_SEPARATOR);
    const body = fields.slice(fields.findIndex((field) => field.trim().startsWith("body:"))).join(FIELD_SEPARATOR).trim().replace(/^body:\s*/, "");
    const reviewer = fieldValue(fields, "reviewer") ?? "unknown";
    return [{
      ...anchor,
      severity: (fieldValue(fields, "severity") ?? "LOW").toUpperCase(),
      reviewer,
      disposition: (fieldValue(fields, "disposition") ?? "").toUpperCase(),
      body,
      fingerprint: fingerprintOf(anchor.filePath, body),
    }];
  });
  const verdict = headerValue("VERDICT").toUpperCase();
  const isWellFormed = VERDICTS.has(verdict) && findings.every((finding) => DISPOSITIONS.has(finding.disposition));
  return { verdict: isWellFormed ? verdict : "FAILED", truncatedLanes, findings };
}

function anchorKey({ filePath, lineNumber, side }) {
  return `${filePath}:${lineNumber ?? "general"}:${side}`;
}

function swarmRowsByAnchor(swarmOutputPath) {
  const swarmFindings = parseReview(JSON.parse(fs.readFileSync(swarmOutputPath, "utf8")).result ?? "").findings;
  return Map.groupBy(swarmFindings, anchorKey);
}

function withSwarmBodies(findings, swarmOutputPath) {
  if (!swarmOutputPath) return { findings, unmatchedBodies: null };
  const rowsByAnchor = swarmRowsByAnchor(swarmOutputPath);
  let unmatchedBodies = 0;
  const findingsWithSwarmBodies = findings.map((finding) => {
    const swarmRows = rowsByAnchor.get(anchorKey(finding)) ?? [];
    if (swarmRows.length !== 1) {
      unmatchedBodies += 1;
      return finding;
    }
    const { body } = swarmRows[0];
    return { ...finding, body, fingerprint: fingerprintOf(finding.filePath, body) };
  });
  return { findings: findingsWithSwarmBodies, unmatchedBodies };
}

function hunkLookup(repoPath, base, head) {
  const rangesByFile = new Map();
  const rangesFor = (filePath) => {
    if (!rangesByFile.has(filePath)) rangesByFile.set(filePath, changedLineRanges(repoPath, filePath, [base, head]));
    return rangesByFile.get(filePath);
  };
  return (filePath, side, lineNumber, slackLines) => {
    const repoRelativePath = path.relative(repoPath, path.resolve(repoPath, filePath));
    if (repoRelativePath.startsWith("..")) return false;
    const ranges = rangesFor(repoRelativePath);
    if (ranges === null) return false;
    if (lineNumber === null) return true;
    const widenedRanges = ranges[side].map(([start, end]) => [start - slackLines, end + slackLines]);
    return isWithinRanges(widenedRanges, lineNumber);
  };
}

function isAnchoredToChange(finding, isNearChangedLine) {
  if (isNearChangedLine(finding.filePath, finding.side, finding.lineNumber, HUNK_SLACK_LINES)) return true;
  return [...finding.body.matchAll(CITED_FILE_LINE)].some(([, citedFile, citedLine]) => isNearChangedLine(citedFile, "RIGHT", Number(citedLine), 0));
}

function atLeast(severity, floorSeverity) {
  return (SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK[floorSeverity];
}

function decideOutcome({ review, round, ledger, actionableFindings, keptFindings }) {
  const priorRounds = roundRows(ledger);
  if (review.verdict === "FAILED") {
    const hasFailedThisRound = priorRounds.some((row) => row.round === round && row.verdict === "FAILED");
    return hasFailedThisRound ? "FAILED" : "RETRY";
  }
  if (keptFindings.some((finding) => finding.disposition === "AMBIGUOUS" && atLeast(finding.severity, "HIGH"))) return "ASKED";
  if (review.truncatedLanes.length > 0) return "FAILED";
  if (actionableFindings.length === 0) return "CLEAN";
  const previousRound = priorRounds.filter((row) => row.round === round - 1 && row.outcome === "CONTINUE").at(-1);
  if (previousRound && actionableFindings.length >= previousRound.actionable) return "STALLED";
  const fixedFingerprints = new Set(ledger.filter((row) => row.type === "fix" && row.outcome === "FIXED").map((row) => row.fingerprint));
  if (actionableFindings.some((finding) => fixedFingerprints.has(finding.fingerprint))) return "STALLED";
  if (round >= ROUND_CAP) return "CAPPED";
  return "CONTINUE";
}

function classifyRound(repoPath, round, base, head, reviewText, swarmOutputPath) {
  const ledgerFile = ledgerPath(repoPath);
  const ledger = readLedger(ledgerFile);
  const parsedReview = parseReview(reviewText);
  const { findings: reviewFindings, unmatchedBodies } = withSwarmBodies(parsedReview.findings, swarmOutputPath);
  const review = { ...parsedReview, findings: reviewFindings };
  const rulingByFingerprint = new Map(ledger.filter((row) => row.type === "ruling").map((row) => [row.fingerprint, row.ruling]));
  const settledFingerprints = new Set([
    ...ledger.filter((row) => row.type === "fix" && row.outcome === "DECLINED").map((row) => row.fingerprint),
    ...[...rulingByFingerprint].filter(([, ruling]) => ruling === "NIT").map(([fingerprint]) => fingerprint),
  ]);
  const isNearChangedLine = hunkLookup(repoPath, base, head);
  const droppedOffHunkByReviewer = {};
  let droppedSettledCount = 0;
  const keptFindings = [];
  for (const finding of review.findings) {
    if (settledFingerprints.has(finding.fingerprint)) {
      droppedSettledCount += 1;
      continue;
    }
    if (!isAnchoredToChange(finding, isNearChangedLine)) {
      droppedOffHunkByReviewer[finding.reviewer] = (droppedOffHunkByReviewer[finding.reviewer] ?? 0) + 1;
      continue;
    }
    const ruledDisposition = rulingByFingerprint.get(finding.fingerprint);
    keptFindings.push(ruledDisposition ? { ...finding, disposition: ruledDisposition } : finding);
  }
  const actionableFindings = keptFindings.filter((finding) => finding.disposition === "ACTIONABLE" && atLeast(finding.severity, "MEDIUM"));
  const outcome = decideOutcome({ review, round, ledger, actionableFindings, keptFindings });
  const findingRows = keptFindings.map((finding) => ({
    type: "finding",
    round,
    fingerprint: finding.fingerprint,
    file: finding.filePath,
    line: finding.lineNumber ?? "general",
    severity: finding.severity,
    reviewer: finding.reviewer,
    disposition: finding.disposition,
  }));
  const roundRow = {
    type: "round",
    round,
    base,
    head,
    verdict: review.verdict,
    outcome,
    actionable: actionableFindings.length,
    droppedOffHunk: droppedOffHunkByReviewer,
    droppedSettled: droppedSettledCount,
  };
  appendRows(ledgerFile, [...findingRows, roundRow]);
  const reportedFinding = ({ fingerprint, filePath, lineNumber, severity, reviewer, body }) => ({ fingerprint, file: filePath, line: lineNumber ?? "general", severity, reviewer, body });
  const askedFindings = outcome === "ASKED" ? keptFindings.filter((finding) => finding.disposition === "AMBIGUOUS" && atLeast(finding.severity, "HIGH")) : [];
  const ambiguousBelowHighFindings = keptFindings.filter((finding) => finding.disposition === "AMBIGUOUS" && !atLeast(finding.severity, "HIGH"));
  finish(outcome, {
    round,
    actionable: actionableFindings.map(reportedFinding),
    asked: askedFindings.map(reportedFinding),
    ambiguous: ambiguousBelowHighFindings.map(reportedFinding),
    droppedOffHunk: droppedOffHunkByReviewer,
    droppedSettled: droppedSettledCount,
    unmatchedBodies,
    truncatedLanes: review.truncatedLanes,
    ledger: ledgerFile,
  });
}

function recordOutcome(repoPath, values) {
  const ledgerFile = ledgerPath(repoPath);
  if (values.fix && FIX_OUTCOMES.has(values.fix)) {
    appendRows(ledgerFile, [{ type: "fix", round: Number(values.round ?? 0), fingerprint: values.fingerprint, outcome: values.fix }]);
    finish("RECORDED", { fingerprint: values.fingerprint, fix: values.fix });
  }
  if (values.ruling && RULINGS.has(values.ruling)) {
    appendRows(ledgerFile, [{ type: "ruling", fingerprint: values.fingerprint, ruling: values.ruling }]);
    finish("RECORDED", { fingerprint: values.fingerprint, ruling: values.ruling });
  }
  failUsage("record needs --fix FIXED|UNVERIFIED|DECLINED or --ruling NIT|ACTIONABLE");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string", default: process.cwd() },
      tree: { type: "string" },
      round: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      "swarm-output": { type: "string" },
      fingerprint: { type: "string" },
      fix: { type: "string" },
      ruling: { type: "string" },
    },
  });
  const repoPath = path.resolve(values.repo);
  if (command === "start") {
    if (!values.tree) failUsage("start needs --tree <working tree id>");
    startRun(repoPath, values.tree);
  }
  if (command === "verify") verifyCleanTree(repoPath);
  if (command === "classify") {
    if (!values.round || !values.base || !values.head) failUsage("classify needs --round, --base and --head, with the review on stdin");
    classifyRound(repoPath, Number(values.round), values.base, values.head, fs.readFileSync(0, "utf8"), values["swarm-output"]);
  }
  if (command === "record") {
    if (!values.fingerprint) failUsage("record needs --fingerprint");
    recordOutcome(repoPath, values);
  }
  failUsage("use start, classify, record or verify");
}

main();
