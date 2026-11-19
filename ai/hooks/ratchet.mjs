#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  elseSyntaxFor, scanCommentLines, scanElseLines, scanUseEffectLines, syntaxFor, useEffectSyntaxFor,
} from "./comment-scanner.mjs";
import { isPathOwned } from "./repo-ownership.mjs";

const BASELINE_RELATIVE_PATH = ".agents/ratchet.json";
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

const RULES = [
  {
    name: "comments",
    syntaxFor,
    scanLines: scanCommentLines,
    fix: "delete the comment and put the intent into names and structure.",
  },
  {
    name: "elseStatements",
    syntaxFor: elseSyntaxFor,
    scanLines: scanElseLines,
    fix: "invert the condition and return, continue, break, or throw early; replace else-if chains with guard clauses or a lookup map.",
  },
  {
    name: "useEffect",
    syntaxFor: useEffectSyntaxFor,
    scanLines: scanUseEffectLines,
    fix: "derive values during render, run side effects in the event handler that causes them, subscribe with useSyncExternalStore, reset state with a key.",
  },
];

const SCANNER_VERSION = createHash("sha256").update(fs.readFileSync(new URL("./comment-scanner.mjs", import.meta.url))).digest("hex").slice(0, 12);

function runGit(directory, args) {
  const gitRun = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (gitRun.status !== 0) throw new Error(`git ${args[0]} failed in ${directory}: ${gitRun.stderr.trim()}`);
  return gitRun.stdout;
}

function nulSeparated(output) {
  return output.split("\0").filter(Boolean);
}

function changedPathsByStatus(repositoryTop) {
  const statusByPath = new Map();
  const entries = nulSeparated(runGit(repositoryTop, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]));
  for (const entry of entries) statusByPath.set(entry.slice(3), entry.slice(0, 2));
  return statusByPath;
}

function committedContent(repositoryTop, repositoryPath) {
  const show = spawnSync("git", ["-C", repositoryTop, "show", `HEAD:${repositoryPath}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return show.status === 0 ? show.stdout : null;
}

function readWorkingFile(filePath) {
  if (!fs.existsSync(filePath)) return { content: null, isSkipped: false };
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) return { content: null, isSkipped: false };
    if (!stats.isFile() || stats.size > MAX_SCANNED_FILE_BYTES) return { content: null, isSkipped: true };
    return { content: fs.readFileSync(filePath, "utf8"), isSkipped: false };
  } catch {
    return { content: null, isSkipped: true };
  }
}

function contentToCount(repositoryTop, repositoryPath, scopePaths, statusByPath) {
  const isInScope = !scopePaths || scopePaths.has(repositoryPath);
  const status = statusByPath.get(repositoryPath);
  if (isInScope || !status) return readWorkingFile(path.join(repositoryTop, repositoryPath));
  if (status === "??") return { content: null, isSkipped: false };
  return { content: committedContent(repositoryTop, repositoryPath), isSkipped: false };
}

export function countViolations(root, scopePaths = null) {
  const repositoryTop = runGit(root, ["rev-parse", "--show-toplevel"]).trim();
  const statusByPath = changedPathsByStatus(repositoryTop);
  const counts = Object.fromEntries(RULES.map((rule) => [rule.name, 0]));
  let isComplete = true;
  const repositoryPaths = nulSeparated(runGit(root, ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", "."]));
  for (const repositoryPath of new Set(repositoryPaths)) {
    const applicableRules = RULES.map((rule) => ({ rule, syntax: rule.syntaxFor(repositoryPath) })).filter(({ syntax }) => syntax);
    if (applicableRules.length === 0) continue;
    const { content, isSkipped } = contentToCount(repositoryTop, repositoryPath, scopePaths, statusByPath);
    if (isSkipped) isComplete = false;
    if (content === null) continue;
    for (const { rule, syntax } of applicableRules) counts[rule.name] += rule.scanLines(content, syntax).length;
  }
  return { counts, isComplete };
}

function baselineRootsIn(repositoryRoot) {
  const repositoryTop = runGit(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim();
  const baselinePaths = nulSeparated(runGit(repositoryTop, ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", BASELINE_RELATIVE_PATH, `*/${BASELINE_RELATIVE_PATH}`]));
  return baselinePaths.map((baselinePath) => ({ repositoryTop, baselinePath, root: path.join(repositoryTop, path.dirname(path.dirname(baselinePath))) }));
}

function writeBaseline(root, counts) {
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(root, BASELINE_RELATIVE_PATH), `${JSON.stringify({ scanner: SCANNER_VERSION, ...counts }, null, 2)}\n`);
}

function raisedRules(committedBaseline, workingBaseline) {
  if (!committedBaseline || !workingBaseline) return [];
  return RULES.filter((rule) => (workingBaseline[rule.name] ?? 0) > (committedBaseline[rule.name] ?? Infinity));
}

function nextRuleBaseline(ruleName, baseline, counts, isComplete) {
  if (!(ruleName in baseline)) return counts[ruleName];
  if (!isComplete) return baseline[ruleName];
  return Math.min(counts[ruleName], baseline[ruleName]);
}

function checkRoot({ repositoryTop, baselinePath, root }, scopePaths) {
  const committedText = committedContent(repositoryTop, baselinePath);
  const committedBaseline = committedText === null ? null : JSON.parse(committedText);
  const workingFile = readWorkingFile(path.join(repositoryTop, baselinePath));
  const workingBaseline = workingFile.content === null ? null : JSON.parse(workingFile.content);
  const raised = raisedRules(committedBaseline, workingBaseline);
  if (raised.length > 0) {
    return raised.map((rule) => `${root}: the ${rule.name} baseline was raised above its committed value. Fix: restore ${baselinePath} and remove the added violations.`);
  }
  const baseline = committedBaseline ?? workingBaseline;
  const { counts, isComplete } = countViolations(root, scopePaths);
  if (baseline.scanner !== SCANNER_VERSION) {
    writeBaseline(root, counts);
    process.stdout.write(`${baselinePath} re-baselined for scanner ${SCANNER_VERSION}: ${JSON.stringify(counts)}\n`);
    return [];
  }
  const grownRules = RULES.filter((rule) => rule.name in baseline && counts[rule.name] > baseline[rule.name]);
  if (grownRules.length > 0) {
    return grownRules.map((rule) => `${root}: ${rule.name} grew from ${baseline[rule.name]} to ${counts[rule.name]}. Fix: ${rule.fix}`);
  }
  const nextBaseline = Object.fromEntries(RULES.map((rule) => [rule.name, nextRuleBaseline(rule.name, baseline, counts, isComplete)]));
  if (RULES.some((rule) => nextBaseline[rule.name] !== baseline[rule.name])) {
    writeBaseline(root, nextBaseline);
    process.stdout.write(`${baselinePath} updated to ${JSON.stringify(nextBaseline)}\n`);
  }
  return [];
}

function runCheck(repositoryRoot, scopeArguments) {
  const scopePaths = scopeArguments.length > 0 ? new Set(scopeArguments) : null;
  const failures = baselineRootsIn(repositoryRoot).flatMap((baselineRoot) => checkRoot(baselineRoot, scopePaths));
  if (failures.length === 0) return 0;
  process.stderr.write(`Ratchet grew past its committed baseline:\n${failures.join("\n")}\n`);
  return 1;
}

function runInit(root) {
  if (!isPathOwned(root)) {
    process.stderr.write(`${root} is not owned by the carbon unit, so no ratchet baseline is written there.\n`);
    return 1;
  }
  const { counts } = countViolations(root);
  writeBaseline(root, counts);
  process.stdout.write(`${path.join(root, BASELINE_RELATIVE_PATH)} written: ${JSON.stringify(counts)}\n`);
  return 0;
}

const COMMANDS = { check: runCheck, init: runInit };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const [commandName, rootArgument, pathsFlag, ...scopeArguments] = process.argv.slice(2);
  const command = COMMANDS[commandName];
  if (!command || !rootArgument || (pathsFlag && pathsFlag !== "--paths")) {
    process.stderr.write("usage: ratchet.mjs check <repo root> [--paths <repo-relative path> ...] | init <owned root>\n");
    process.exit(2);
  }
  process.exit(command(path.resolve(rootArgument), scopeArguments));
}
