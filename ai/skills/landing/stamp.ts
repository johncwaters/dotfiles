import { Git } from "./lib/git.ts";
import {
  changedPathsOutside,
  clearStampLedger,
  EMPTY_FINDINGS,
  isStampGate,
  parseStampFindings,
  STAMP_GATES,
  type StampFindings,
  verifyStamp,
  writeStamp,
} from "./lib/stamp.ts";
import { readStdin } from "./lib/stdio.ts";
import { readResolvedPolicy } from "./lib/visibility.ts";

const USAGE = `usage: stamp.ts write --gate <${STAMP_GATES.join("|")}> (--paths | --only) <path>... [--findings -] | verify | clear`;

function fail(reason: string): never {
  process.stderr.write(`${reason}\n${USAGE}\n`);
  process.exit(2);
}

function parseWriteArguments(argv: string[]): { gate: string; paths: string[]; readsFindings: boolean; refusesOtherChanges: boolean } {
  const parsed = { gate: "", paths: [] as string[], readsFindings: false, refusesOtherChanges: false };
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
      if (argv[index + 1] !== "-") {
        fail("--findings takes - to read the findings JSON from stdin");
      }
      parsed.readsFindings = true;
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

async function writeCommand(git: Git, argv: string[]): Promise<void> {
  const { gate, paths, readsFindings, refusesOtherChanges } = parseWriteArguments(argv);
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
  const findings: StampFindings = readsFindings ? parseStampFindings(JSON.parse(await readStdin())) : EMPTY_FINDINGS;
  process.stdout.write(`${JSON.stringify(writeStamp(git, gate, paths, findings))}\n`);
}

const git = new Git(process.cwd());
const [command, ...rest] = process.argv.slice(2);
if (command === "write") {
  await writeCommand(git, rest);
  process.exit(0);
}
if (command === "verify") {
  const verification = verifyStamp(git);
  const { profile, policy, remoteVisibility, warnings } = readResolvedPolicy(git);
  process.stdout.write(`${JSON.stringify({ ...verification, ...(profile ? { profile } : {}), ...(policy ? { policy } : {}), remoteVisibility, warnings })}\n`);
  process.exit(verification.matches ? 0 : 1);
}
if (command === "clear") {
  clearStampLedger(git);
  process.exit(0);
}
fail(`unknown command ${command ?? "(none)"}`);
