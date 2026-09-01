#!/usr/bin/env node
/**
 * SessionStart hook that turns on caveman ultra mode.
 *
 * Cannot block anything: it prints the ultra mode instruction to stdout and
 * writes "ultra" to ~/.claude/.caveman-active, the flag the caveman plugin
 * reads. Fails open on every error (never throws, never exits non-zero).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const message =
  "CAVEMAN ULTRA MODE ACTIVE. Overrides any caveman-full activation this session. Rules: all full caveman rules (drop articles/filler/pleasantries/hedging, fragments OK, short synonyms) plus ultra: abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X -> Y), one word when one word enough. Code/commits/PRs/security warnings: write normal. User says 'normal' or 'stop caveman' to deactivate.";

process.stdout.write(message);

const cavemanFlagPath = join(homedir(), ".claude", ".caveman-active");
const pollIntervalMs = 100;
const pollDeadlineMs = 4000;

function readFlagContent() {
  try {
    return readFileSync(cavemanFlagPath, "utf8").trim();
  } catch {
    return null;
  }
}

function readFlagWriteIdentity() {
  try {
    const flagStats = statSync(cavemanFlagPath);
    return `${flagStats.ino}:${flagStats.mtimeMs}`;
  } catch {
    return null;
  }
}

function writeUltraFlag() {
  try {
    mkdirSync(dirname(cavemanFlagPath), { recursive: true });
    writeFileSync(cavemanFlagPath, "ultra");
  } catch (error) {
    process.stderr.write(`caveman-ultra: flag write failed: ${error.message}\n`);
  }
  process.exit(0);
}

// The racing caveman plugin rewrites the same bytes it already wrote, so only a new inode or mtime proves its write landed and that "ultra" gets the last word.
const flagWriteIdentityBeforePoll = readFlagWriteIdentity();

const willPluginResolveUltraToo =
  readFlagContent() === "ultra" && process.env.CAVEMAN_DEFAULT_MODE === "ultra";
if (willPluginResolveUltraToo) writeUltraFlag();

let elapsedMs = 0;
const poll = setInterval(() => {
  elapsedMs += pollIntervalMs;
  const isDeadlineReached = elapsedMs >= pollDeadlineMs;
  const hasFlagBeenRewrittenSincePollStart =
    readFlagWriteIdentity() !== flagWriteIdentityBeforePoll;
  if (!hasFlagBeenRewrittenSincePollStart && !isDeadlineReached) return;
  clearInterval(poll);
  writeUltraFlag();
}, pollIntervalMs);
