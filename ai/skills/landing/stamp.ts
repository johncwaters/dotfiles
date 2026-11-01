import { Git } from "./lib/git.ts";
import {
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

const USAGE = `usage: stamp.ts write --gate <${STAMP_GATES.join("|")}> --paths <path>... [--findings -] | verify | clear`;

function fail(reason: string): never {
  process.stderr.write(`${reason}\n${USAGE}\n`);
  process.exit(2);
}

function parseWriteArguments(argv: string[]): { gate: string; paths: string[]; readsFindings: boolean } {
  const parsed = { gate: "", paths: [] as string[], readsFindings: false };
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
    if (argument === "--paths") {
      collectingPaths = true;
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
  const { gate, paths, readsFindings } = parseWriteArguments(argv);
  if (!isStampGate(gate)) {
    fail(`--gate must be one of ${STAMP_GATES.join(", ")}`);
  }
  if (paths.length === 0) {
    fail("--paths needs at least one path");
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
  process.stdout.write(`${JSON.stringify(verification)}\n`);
  process.exit(verification.matches ? 0 : 1);
}
if (command === "clear") {
  clearStampLedger(git);
  process.exit(0);
}
fail(`unknown command ${command ?? "(none)"}`);
