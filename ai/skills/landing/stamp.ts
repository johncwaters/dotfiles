import { Git } from "./lib/git.ts";
import {
  BrowserCodeFailed,
  changedPathsOutside,
  EMPTY_FINDINGS,
  isStampGate,
  parseStampFindings,
  releaseBranch,
  STAMP_GATES,
  type StampFindings,
  type StampGate,
  type StampRow,
  verifyStamp,
  writeStamp,
} from "./lib/stamp.ts";
import fs from "node:fs";
import { readResolvedPolicy } from "./lib/visibility.ts";

const BROWSER_CODE_FAILED_EXIT_CODE = 30;
const USAGE = `usage: stamp.ts write --gate <${STAMP_GATES.join("|")}> (--paths | --only) <path>... [--findings <file>] | verify | clear`;

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

function parseWriteArguments(argv: string[]): { gate: string; paths: string[]; findingsFile: string | null; refusesOtherChanges: boolean } {
  const parsed = { gate: "", paths: [] as string[], findingsFile: null as string | null, refusesOtherChanges: false };
  let collectingPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
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
  return parsed;
}

function writeCommand(git: Git, argv: string[]): void {
  const { gate, paths, findingsFile, refusesOtherChanges } = parseWriteArguments(argv);
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
  process.stdout.write(`${JSON.stringify(writeStampOrExit(git, gate, paths, findings))}\n`);
}

function writeStampOrExit(git: Git, gate: StampGate, paths: string[], findings: StampFindings): StampRow {
  try {
    return writeStamp(git, gate, paths, findings);
  } catch (error) {
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
fail(`unknown command ${command ?? "(none)"}`);
