#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const OVERALL_DEADLINE_MS = 10000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_PRINTED_LENGTH = 120;
const MAX_PRINTED_CONFLICTS = 10;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const SCHEME_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_URL_PATTERN = /^[^/]*:/;

function ageSince(at) {
  const elapsedMs = Date.now() - Date.parse(at);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "0h";
  }
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
}

function inertCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) {
    return " ";
  }
  if (character === "`") {
    return "'";
  }
  return character;
}

function inert(value) {
  const bounded = String(value).slice(0, MAX_PRINTED_LENGTH * 4);
  const flattened = Array.from(bounded, inertCharacter)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length > MAX_PRINTED_LENGTH) {
    return `\`${flattened.slice(0, MAX_PRINTED_LENGTH)}...\``;
  }
  return `\`${flattened}\``;
}

function isInheritedGitSetting(variableName) {
  return (
    variableName.startsWith("GIT_CONFIG") ||
    variableName === "GIT_DIR" ||
    variableName === "GIT_WORK_TREE" ||
    variableName === "GIT_COMMON_DIR"
  );
}

function probeEnvironment() {
  const inherited = { ...process.env };
  for (const variableName of Object.keys(inherited)) {
    if (isInheritedGitSetting(variableName)) {
      delete inherited[variableName];
    }
  }
  return {
    ...inherited,
    GIT_CEILING_DIRECTORIES: tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
  };
}

let scratchProbeDirectory = null;

function ensureScratchProbeDirectory() {
  if (scratchProbeDirectory !== null) {
    return scratchProbeDirectory;
  }
  try {
    scratchProbeDirectory = mkdtempSync(join(tmpdir(), "parked-probe-"));
  } catch {
    return null;
  }
  return scratchProbeDirectory;
}

function discardScratchProbeDirectory() {
  if (scratchProbeDirectory === null) {
    return;
  }
  const usedDirectory = scratchProbeDirectory;
  scratchProbeDirectory = null;
  try {
    rmSync(usedDirectory, { recursive: true, force: true });
  } catch {
    return;
  }
}

function killProcessGroup(pid) {
  if (typeof pid !== "number" || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

function runGitProbe(probeArguments, deadlineAtMs) {
  const budgetMs = Math.min(PROBE_TIMEOUT_MS, deadlineAtMs - Date.now());
  if (budgetMs <= 0) {
    return null;
  }
  const probeDirectory = ensureScratchProbeDirectory();
  if (probeDirectory === null) {
    return null;
  }
  const probe = spawnSync("git", probeArguments, {
    cwd: probeDirectory,
    encoding: "utf8",
    env: probeEnvironment(),
    timeout: budgetMs,
    killSignal: "SIGKILL",
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error) {
    killProcessGroup(probe.pid);
    return null;
  }
  return probe;
}

function runLocalGitProbe(gitCommonDir, probeArguments, deadlineAtMs) {
  return runGitProbe([`--git-dir=${gitCommonDir}`, ...probeArguments], deadlineAtMs);
}

function absoluteOriginUrl(configuredUrl, repoDirectory) {
  if (SCHEME_URL_PATTERN.test(configuredUrl) || HOST_URL_PATTERN.test(configuredUrl)) {
    return configuredUrl;
  }
  if (isAbsolute(configuredUrl)) {
    return configuredUrl;
  }
  return resolve(repoDirectory, configuredUrl);
}

function originUrl(gitCommonDir, repoDirectory, deadlineAtMs) {
  const probe = runLocalGitProbe(
    gitCommonDir,
    ["config", "--get", "remote.origin.url"],
    deadlineAtMs,
  );
  if (probe === null) {
    return null;
  }
  if (probe.status !== 0) {
    return "";
  }
  const configuredUrl = (probe.stdout ?? "").trim();
  if (configuredUrl === "") {
    return "";
  }
  return absoluteOriginUrl(configuredUrl, repoDirectory);
}

function remoteBranches(url, deadlineAtMs) {
  const probe = runGitProbe(
    [
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.git.allow=never",
      "ls-remote",
      "--heads",
      "--upload-pack=git-upload-pack",
      "--",
      url,
    ],
    deadlineAtMs,
  );
  if (probe === null || probe.status !== 0) {
    return null;
  }
  const branches = new Set();
  for (const line of (probe.stdout ?? "").split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref?.startsWith("refs/heads/")) {
      continue;
    }
    branches.add(ref.slice("refs/heads/".length));
  }
  return branches;
}

function localBranchExists(gitCommonDir, branch, deadlineAtMs) {
  const probe = runLocalGitProbe(
    gitCommonDir,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    deadlineAtMs,
  );
  if (probe === null) {
    return null;
  }
  if (probe.status === 0) {
    return true;
  }
  if (probe.status === 1) {
    return false;
  }
  return null;
}

function landedOnMainline(entry, gitCommonDir, deadlineAtMs) {
  if (!entry.mainline || !COMMIT_PATTERN.test(entry.commit)) {
    return false;
  }
  const probe = runLocalGitProbe(
    gitCommonDir,
    ["merge-base", "--is-ancestor", entry.commit, `refs/remotes/origin/${entry.mainline}`],
    deadlineAtMs,
  );
  return probe !== null && probe.status === 0;
}

function entryStatus(entry, gitCommonDir, originConfigured, remoteBranchNames, deadlineAtMs) {
  if (landedOnMainline(entry, gitCommonDir, deadlineAtMs)) {
    return "resolved";
  }
  const isOnOrigin = remoteBranchNames === null ? null : remoteBranchNames.has(entry.branch);
  if (entry.pushed && isOnOrigin === false) {
    return "resolved";
  }
  if (!entry.pushed && localBranchExists(gitCommonDir, entry.branch, deadlineAtMs) === false) {
    return "resolved";
  }
  if (isOnOrigin === true) {
    return "on origin";
  }
  if (originConfigured === false || remoteBranchNames !== null) {
    return "local only";
  }
  return "unverified";
}

function repositoryReports(gitCommonDir, repositoryEntries, deadlineAtMs) {
  if (!existsSync(gitCommonDir)) {
    return repositoryEntries.map((entry) => ({ entry, status: "unverified" }));
  }
  const repoDirectory = repositoryEntries[0]?.repo ?? tmpdir();
  const url = originUrl(gitCommonDir, repoDirectory, deadlineAtMs);
  const originConfigured = url === null ? null : url !== "";
  const remoteBranchNames = originConfigured === true ? remoteBranches(url, deadlineAtMs) : null;
  return repositoryEntries.map((entry) => ({
    entry,
    status: entryStatus(entry, gitCommonDir, originConfigured, remoteBranchNames, deadlineAtMs),
  }));
}

function groupByCommonDir(entries) {
  const entriesByCommonDir = new Map();
  for (const entry of entries) {
    const groupedEntries = entriesByCommonDir.get(entry.gitCommonDir) ?? [];
    groupedEntries.push(entry);
    entriesByCommonDir.set(entry.gitCommonDir, groupedEntries);
  }
  return entriesByCommonDir;
}

function conflictsLine(conflicts) {
  const shown = conflicts.slice(0, MAX_PRINTED_CONFLICTS).map(inert).join(", ");
  if (conflicts.length > MAX_PRINTED_CONFLICTS) {
    return `${shown} (+${conflicts.length - MAX_PRINTED_CONFLICTS} more)`;
  }
  return shown;
}

function printReports(reports) {
  if (reports.length === 0) {
    return;
  }
  const lines = ["Parked branches:"];
  for (const { entry, status } of reports) {
    lines.push(
      [
        inert(basename(entry.repo)),
        inert(entry.branch),
        inert(entry.outcome),
        inert(ageSince(entry.at)),
        inert(entry.commit.slice(0, 7)),
        status,
      ].join("  "),
    );
    if (entry.conflicts.length > 0) {
      lines.push(`  conflicts: ${conflictsLine(entry.conflicts)}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

try {
  const {
    compactLedger,
    entryKey,
    entryPathsAreAbsolute,
    ledgerPath,
    newestEntryPerBranch,
    parseLedger,
    supersededKeys,
  } = await import("../skills/committing/lib/ledger.ts");
  const atPath = ledgerPath();
  const { entries } = parseLedger(readFileSync(atPath, "utf8"));
  const addressableEntries = entries.filter(entryPathsAreAbsolute);
  const newestEntries = newestEntryPerBranch(addressableEntries);
  const droppedKeys = supersededKeys(addressableEntries, newestEntries);
  const deadlineAtMs = Date.now() + OVERALL_DEADLINE_MS;
  const liveReports = [];
  for (const [gitCommonDir, repositoryEntries] of groupByCommonDir(newestEntries)) {
    for (const report of repositoryReports(gitCommonDir, repositoryEntries, deadlineAtMs)) {
      if (report.status === "resolved") {
        droppedKeys.add(entryKey(report.entry));
        continue;
      }
      liveReports.push(report);
    }
  }
  printReports(liveReports);
  if (droppedKeys.size > 0) {
    compactLedger(atPath, (entry) => droppedKeys.has(entryKey(entry)));
  }
  discardScratchProbeDirectory();
} catch {
  discardScratchProbeDirectory();
  process.exit(0);
}
