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
import { Git } from "../landing/lib/git.ts";
import { EMPTY_FINDINGS, pinScopedTree, writeStamp } from "../landing/lib/stamp.ts";

const EXIT_CODE_BY_OUTCOME = {
  FRESH: 0,
  RESUME: 0,
  RECORDED: 0,
  CLEAN: 0,
  CONTINUE: 10,
  RETRY: 11,
  SWEEP: 12,
  ASKED: 20,
  STALLED: 21,
  CAPPED: 22,
  FAILED: 23,
  STAMPED: 0,
  UNSTAMPED: 24,
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
const HOOK_SCRIPT_RUN = /\b(npm|pnpm|yarn)\s+(?:run\s+)?(?:-{1,2}[\w-]+\s+)*([\w:.-]+)/g;
const FALLBACK_GATE_SCRIPTS = ["check:fast", "test"];
const GATE_OUTPUT_LINES = 30;
const GATE_FAILURE_LINE = /^\s*not ok\b|^\s*✖|\bFAIL\b|\bError:|\berror TS\d+|^\s*\d+:\d+\s+error\b/;

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

function stampCleanTree(repoPath, paths) {
  const git = new Git(repoPath);
  const workingTree = pinScopedTree(git, ["."]);
  const ledger = readLedger(ledgerPath(repoPath));
  const lastRound = roundRows(ledger).at(-1);
  if (lastRound?.outcome !== "CLEAN" || lastRound.head !== workingTree) {
    finish("UNSTAMPED", { tree: workingTree, lastRound: lastRound ?? null });
  }
  const unverifiedFingerprints = new Set(ledger.filter((row) => row.type === "fix" && row.outcome === "UNVERIFIED").map((row) => row.fingerprint));
  const unverifiedFindings = ledger
    .filter((row) => row.type === "finding" && unverifiedFingerprints.has(row.fingerprint))
    .map((row) => ({ severity: row.severity, file: row.file, summary: `${row.reviewer} finding ${row.fingerprint}, fix unverified` }));
  const stamp = writeStamp(git, "converging-reviews", paths, { ...EMPTY_FINDINGS, unverifiedFindings });
  finish("STAMPED", { tree: workingTree, stamp });
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

function prePushHookFiles(repoPath, repoRoot) {
  const configuredHooksPath = spawnSync("git", ["config", "core.hooksPath"], { cwd: repoPath, encoding: "utf8" }).stdout.trim();
  const hooksDirectory = configuredHooksPath ? path.resolve(repoRoot, configuredHooksPath) : path.resolve(repoPath, runGit(repoPath, ["rev-parse", "--git-path", "hooks"]).trim());
  const isHuskyStubDirectory = path.basename(hooksDirectory) === "_";
  const candidateFiles = [path.join(hooksDirectory, "pre-push"), ...(isHuskyStubDirectory ? [path.join(path.dirname(hooksDirectory), "pre-push")] : [])];
  return candidateFiles.filter((hookFile) => fs.existsSync(hookFile));
}

function scriptRunIn(hookText, packageScripts) {
  for (const [, runner, script] of hookText.matchAll(HOOK_SCRIPT_RUN)) {
    if (Object.hasOwn(packageScripts, script)) return { runner, script };
  }
  return null;
}

function findGate(repoPath) {
  const repoRoot = runGit(repoPath, ["rev-parse", "--show-toplevel"]).trim();
  const packageFile = path.join(repoRoot, "package.json");
  const packageScripts = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, "utf8")).scripts ?? {} : {};
  const hookFiles = prePushHookFiles(repoPath, repoRoot);
  for (const hookFile of hookFiles) {
    const scriptRun = scriptRunIn(fs.readFileSync(hookFile, "utf8"), packageScripts);
    if (scriptRun) return { command: [scriptRun.runner, "run", scriptRun.script], name: scriptRun.script, source: "pre-push hook" };
  }
  const userHookFile = hookFiles.at(-1);
  if (userHookFile) return { command: ["sh", userHookFile], name: "pre-push", source: "pre-push hook, run whole since no package script was found in it" };
  const fallbackScript = FALLBACK_GATE_SCRIPTS.find((scriptName) => Object.hasOwn(packageScripts, scriptName));
  return fallbackScript ? { command: ["npm", "run", fallbackScript], name: fallbackScript, source: "package.json" } : null;
}

function gateFingerprint(gateName, outputLines) {
  const failureLines = outputLines.filter((line) => GATE_FAILURE_LINE.test(line));
  const identifyingLines = failureLines.length > 0 ? failureLines : outputLines.slice(-GATE_OUTPUT_LINES);
  const normalizedLines = identifyingLines.map((line) => line.replace(/\d+(\.\d+)?\s*m?s\b/g, "").trim());
  return createHash("sha1").update(`gate/${gateName}\n${normalizedLines.join("\n")}`).digest("hex").slice(0, 12);
}

function runGate(repoPath) {
  const gateCommand = findGate(repoPath);
  if (gateCommand === null) return { gate: null, gateFinding: null };
  const [program, ...programArguments] = gateCommand.command;
  const gateRun = spawnSync(program, programArguments, { cwd: repoPath, encoding: "utf8", input: "", maxBuffer: 256 * 1024 * 1024 });
  const exitCode = gateRun.status ?? 1;
  const gate = { command: gateCommand.command.join(" "), name: gateCommand.name, source: gateCommand.source, exitCode };
  if (exitCode === 0) return { gate, gateFinding: null };
  const outputLines = `${gateRun.stdout ?? ""}${gateRun.stderr ?? ""}${gateRun.error?.message ?? ""}`.split("\n").filter((line) => line.trim() !== "");
  const firstFailureIndex = outputLines.findIndex((line) => GATE_FAILURE_LINE.test(line));
  const proofLines = firstFailureIndex === -1 ? outputLines.slice(-GATE_OUTPUT_LINES) : outputLines.slice(firstFailureIndex, firstFailureIndex + GATE_OUTPUT_LINES);
  const gateReviewer = `gate/${gateCommand.name}`;
  const body = `\`${gate.command}\` from the ${gateCommand.source} exits ${exitCode}. Proof: it printed: ${proofLines.join("\n")}`;
  const gateFinding = { filePath: gateReviewer, lineNumber: null, side: "RIGHT", severity: "HIGH", reviewer: gateReviewer, disposition: "ACTIONABLE", body, fingerprint: gateFingerprint(gateCommand.name, outputLines) };
  return { gate, gateFinding };
}

function atLeast(severity, floorSeverity) {
  return (SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK[floorSeverity];
}

function lastConcludedRounds(ledger) {
  const latestRowByRound = new Map(roundRows(ledger).map((row) => [row.round, row]));
  return [...latestRowByRound.values()].filter((row) => row.outcome !== "RETRY");
}

function roundPlan(ledger, round) {
  const earlierRounds = lastConcludedRounds(ledger).filter((row) => row.round < round);
  const previousRound = earlierRounds.at(-1);
  if (!previousRound) return { kind: "full", severityFloor: "MEDIUM", sweepBase: null };
  const sweepBase = earlierRounds[0].base;
  if (previousRound.outcome === "SWEEP") {
    const isFirstSweep = !earlierRounds.some((row) => row.kind === "sweep");
    return { kind: "sweep", severityFloor: isFirstSweep ? "MEDIUM" : "HIGH", sweepBase };
  }
  return { kind: "delta", severityFloor: "HIGH", sweepBase };
}

function stallBaseline(ledger, round, plan) {
  const earlierRounds = lastConcludedRounds(ledger).filter((row) => row.round < round && row.outcome === "CONTINUE");
  if (plan.kind === "sweep") return earlierRounds.filter((row) => row.kind === "sweep").at(-1);
  return earlierRounds.find((row) => row.round === round - 1 && row.kind === "delta");
}

function decideOutcome({ review, round, plan, ledger, actionableFindings, keptFindings }) {
  if (review.verdict === "FAILED") {
    const hasFailedThisRound = roundRows(ledger).some((row) => row.round === round && row.verdict === "FAILED");
    return hasFailedThisRound ? "FAILED" : "RETRY";
  }
  if (keptFindings.some((finding) => finding.disposition === "AMBIGUOUS" && atLeast(finding.severity, "HIGH"))) return "ASKED";
  if (review.truncatedLanes.length > 0) return "FAILED";
  const fixedFingerprints = new Set(ledger.filter((row) => row.type === "fix" && row.outcome === "FIXED").map((row) => row.fingerprint));
  const isFixedDefectBack = keptFindings.some((finding) => finding.disposition === "ACTIONABLE" && fixedFingerprints.has(finding.fingerprint));
  if (isFixedDefectBack) return "STALLED";
  if (actionableFindings.length === 0 && plan.kind !== "delta") return "CLEAN";
  if (round >= ROUND_CAP) return "CAPPED";
  if (actionableFindings.length === 0) return "SWEEP";
  const baselineRound = stallBaseline(ledger, round, plan);
  if (baselineRound && actionableFindings.length >= baselineRound.actionable) return "STALLED";
  return "CONTINUE";
}

function classifyRound(repoPath, round, requestedBase, head, reviewText, swarmOutputPath) {
  const ledgerFile = ledgerPath(repoPath);
  const ledger = readLedger(ledgerFile);
  const plan = roundPlan(ledger, round);
  const base = plan.kind === "sweep" ? plan.sweepBase : requestedBase;
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
  const { gate, gateFinding } = runGate(repoPath);
  if (gateFinding) keptFindings.push(gateFinding);
  const actionableFindings = keptFindings.filter((finding) => finding.disposition === "ACTIONABLE" && atLeast(finding.severity, plan.severityFloor));
  const outcome = decideOutcome({ review, round, plan, ledger, actionableFindings, keptFindings });
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
    kind: plan.kind,
    severityFloor: plan.severityFloor,
    base,
    head,
    verdict: review.verdict,
    outcome,
    actionable: actionableFindings.length,
    droppedOffHunk: droppedOffHunkByReviewer,
    droppedSettled: droppedSettledCount,
    gate,
  };
  appendRows(ledgerFile, [...findingRows, roundRow]);
  const reportedFinding = ({ fingerprint, filePath, lineNumber, severity, reviewer, body }) => ({ fingerprint, file: filePath, line: lineNumber ?? "general", severity, reviewer, body });
  const askedFindings = outcome === "ASKED" ? keptFindings.filter((finding) => finding.disposition === "AMBIGUOUS" && atLeast(finding.severity, "HIGH")) : [];
  const ambiguousBelowHighFindings = keptFindings.filter((finding) => finding.disposition === "AMBIGUOUS" && !atLeast(finding.severity, "HIGH"));
  const sweepHandoff = outcome === "SWEEP" ? { nextRound: round + 1, base: plan.sweepBase, head } : {};
  finish(outcome, {
    round,
    kind: plan.kind,
    severityFloor: plan.severityFloor,
    ...sweepHandoff,
    actionable: actionableFindings.map(reportedFinding),
    asked: askedFindings.map(reportedFinding),
    ambiguous: ambiguousBelowHighFindings.map(reportedFinding),
    droppedOffHunk: droppedOffHunkByReviewer,
    droppedSettled: droppedSettledCount,
    unmatchedBodies,
    truncatedLanes: review.truncatedLanes,
    gate,
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
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
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
  if (command === "stamp") {
    if (positionals.length === 0) failUsage("stamp needs the changed-file paths after --");
    stampCleanTree(repoPath, positionals);
  }
  if (command === "classify") {
    if (!values.round || !values.base || !values.head) failUsage("classify needs --round, --base and --head, with the review on stdin");
    classifyRound(repoPath, Number(values.round), values.base, values.head, fs.readFileSync(0, "utf8"), values["swarm-output"]);
  }
  if (command === "record") {
    if (!values.fingerprint) failUsage("record needs --fingerprint");
    recordOutcome(repoPath, values);
  }
  failUsage("use start, classify, record or stamp");
}

main();
