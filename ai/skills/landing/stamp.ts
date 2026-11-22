import { Git } from "./lib/git.ts";
import {
  BrowserCodeFailed,
  changedPathsOutside,
  EMPTY_FINDINGS,
  isStampGate,
  parseReviewFile,
  parseStampFindings,
  releaseBranch,
  type ReviewRecord,
  STAMP_GATES,
  type StampFindings,
  UiEvidenceMissing,
  uiEvidenceFromFlags,
  type UiEvidence,
  type StampGate,
  type StampRow,
  verifyStamp,
  writeStamp,
} from "./lib/stamp.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readResolvedPolicy } from "./lib/visibility.ts";

const BROWSER_CODE_FAILED_EXIT_CODE = 30;
const UI_EVIDENCE_MISSING_EXIT_CODE = 31;
const USAGE = `usage: stamp.ts write --gate <${STAMP_GATES.join("|")}> (--paths | --only) <path>... [--findings <file>] [--review-file <file>] [--ui-evidence <layout-shift report> | --no-ui-evidence <reason>] | verify | clear | pin`;

function releaseBaseRef(git: Git): string | null {
  const { mainline } = readResolvedPolicy(git);
  if (mainline === null) {
    return null;
  }
  return [`refs/remotes/origin/${mainline}`, `refs/heads/${mainline}`].find((ref) => git.verifyRef(ref)) ?? null;
}

function fail(reason: string): never {
  process.stderr.write(`${reason}\n${USAGE}\n`);
  process.exit(2);
}

type WriteArguments = { gate: string; paths: string[]; findingsFile: string | null; reviewFile: string | null; refusesOtherChanges: boolean; uiEvidence: UiEvidence };

function parseWriteArguments(argv: string[]): WriteArguments {
  const parsed = { gate: "", paths: [] as string[], findingsFile: null as string | null, reviewFile: null as string | null, refusesOtherChanges: false };
  let reportFile: string | undefined;
  let waiverReason: string | undefined;
  let collectingPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--ui-evidence" || argument === "--no-ui-evidence") {
      const value = argv[index + 1] ?? "";
      if (argument === "--ui-evidence") reportFile = value;
      if (argument === "--no-ui-evidence") waiverReason = value;
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument === "--gate") {
      parsed.gate = argv[index + 1] ?? "";
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument === "--findings") {
      const findingsFile = argv[index + 1] ?? "";
      if (findingsFile === "" || findingsFile === "-") {
        fail("--findings takes the path of a findings JSON file written with the Write tool");
      }
      parsed.findingsFile = findingsFile;
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument === "--review-file") {
      parsed.reviewFile = argv[index + 1] ?? "";
      if (parsed.reviewFile === "") fail("--review-file takes the REVIEW_FILE path reviewing-code returned");
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument === "--paths" || argument === "--only") {
      collectingPaths = true;
      parsed.refusesOtherChanges ||= argument === "--only";
      continue;
    }
    if (!collectingPaths) {
      fail(`unknown argument ${argument}`);
    }
    parsed.paths.push(argument);
  }
  const uiEvidence = uiEvidenceFromFlags(reportFile, waiverReason);
  if (typeof uiEvidence === "string") {
    fail(uiEvidence);
  }
  return { ...parsed, uiEvidence };
}

function writeCommand(git: Git, argv: string[]): void {
  const { gate, paths, findingsFile, reviewFile, refusesOtherChanges, uiEvidence } = parseWriteArguments(argv);
  if (!isStampGate(gate)) {
    fail(`--gate must be one of ${STAMP_GATES.join(", ")}`);
  }
  if (paths.length === 0) {
    fail("--paths needs at least one path");
  }
  if (refusesOtherChanges) {
    const outsidePaths = changedPathsOutside(git, paths);
    if (outsidePaths === null) {
      fail("could not pin the working tree to check --only");
    }
    if (outsidePaths.length > 0) {
      fail(`--only refuses a tree that also changes ${outsidePaths.join(", ")}`);
    }
  }
  const findings: StampFindings = findingsFile === null ? EMPTY_FINDINGS : parseStampFindings(JSON.parse(fs.readFileSync(findingsFile, "utf8")));
  const reviewRecord = reviewFile === null ? undefined : parseReviewFile(fs.readFileSync(reviewFile, "utf8"));
  process.stdout.write(`${JSON.stringify(writeStampOrExit(git, gate, paths, findings, uiEvidence, reviewRecord))}\n`);
}

function writeStampOrExit(git: Git, gate: StampGate, paths: string[], findings: StampFindings, uiEvidence: UiEvidence, reviewRecord?: ReviewRecord): StampRow {
  try {
    return writeStamp(git, gate, paths, findings, uiEvidence, reviewRecord);
  } catch (error) {
    if (error instanceof UiEvidenceMissing) {
      process.stderr.write(`UI_EVIDENCE_MISSING: serve the changed UI, run node ~/.claude/skills/designing-ui/scripts/layout-shift.mjs --url <url> --report $(mktemp -d)/ui.json until it exits 0, then pass --ui-evidence <that report>, or --no-ui-evidence <reason>\n${error.message}\n`);
      process.exit(UI_EVIDENCE_MISSING_EXIT_CODE);
    }
    if (!(error instanceof BrowserCodeFailed)) throw error;
    process.stderr.write(`BROWSER_CODE_FAILED: fix each failure as new work, then review again\n${error.failureLines.join("\n")}\n`);
    process.exit(BROWSER_CODE_FAILED_EXIT_CODE);
  }
}

const git = new Git(process.cwd());
const [command, ...rest] = process.argv.slice(2);
if (command === "write") {
  writeCommand(git, rest);
  process.exit(0);
}
if (command === "verify") {
  const verification = verifyStamp(git);
  const { profile, policy, remoteVisibility, warnings } = readResolvedPolicy(git);
  process.stdout.write(`${JSON.stringify({ ...verification, ...(profile ? { profile } : {}), ...(policy ? { policy } : {}), remoteVisibility, warnings })}\n`);
  process.exit(verification.matches ? 0 : 1);
}
if (command === "clear") {
  releaseBranch(git, releaseBaseRef(git));
  process.exit(0);
}
function snapshotWorkingTree(scratchIndexPath: string): string | null {
  try {
    return git.workingTreeOid(scratchIndexPath);
  } catch {
    return null;
  }
}

if (command === "pin") {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "review-pin-"));
  try {
    const tree = snapshotWorkingTree(path.join(scratchDirectory, "index"));
    if (tree === null) {
      fail("could not snapshot the working tree");
    }
    process.stdout.write(`${tree}\n`);
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
  process.exit(0);
}
fail(`unknown command ${command ?? "(none)"}`);
