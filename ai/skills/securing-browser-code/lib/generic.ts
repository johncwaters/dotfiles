import path from "node:path";
import type { CheckFailure, PackageManifest, TrackedFile } from "./audit.ts";

const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCAL_SPECIFIER_PATTERN = /^(?:workspace|file|link|portal):/;
const NPM_ALIAS_PATTERN = /^npm:(?:@[^/@]+\/)?[^@]+@(.+)$/;
const INSTALL_CONFIG_PATTERN = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.github\/actions\/.+\/action\.ya?ml|(?:.*\/)?\.gitlab-ci\.ya?ml|(?:.*\/)?netlify\.toml|(?:.*\/)?vercel\.json|(?:.*\/)?Dockerfile[^/]*)$/;
const INSTALL_COMMAND_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add)\b([^\n&|;"]*)/g;
const BARE_YARN_PATTERN = /(?<=(?:^|[&|;]|=\s*["']?|\brun:|\bRUN|^\s*-)\s*)\byarn((?:\s+-[^\s&|;"']+)*)\s*(?=$|[&|;"'])/g;
const NON_INSTALL_YARN_FLAG_PATTERN = /(?:^|\s)(?:-v|--version|-h|--help)(?:\s|$)/;
const GLOBAL_INSTALL_PATTERN = /(?:^|\s)(?:-g|--global)\b/;
const LINE_CONTINUATION_PATTERN = /\\\r?\n/;
const FROZEN_FLAG_BY_MANAGER: Record<string, RegExp> = {
  pnpm: /--frozen-lockfile(?:=true)?(?![=\w-])/,
  yarn: /--(?:frozen-lockfile|immutable)(?:=true)?(?![=\w-])/,
  bun: /--frozen-lockfile(?:=true)?(?![=\w-])/,
};

type InstallCommand = { manager: string; subcommand: string; installArguments: string; commandText: string };

export function findUnpinnedDependencies(manifests: PackageManifest[]): CheckFailure[] {
  return manifests.flatMap((manifest) =>
    Object.entries(manifest.dependencies)
      .filter(([, specifier]) => !isExactSpecifier(specifier))
      .map(([packageName, specifier]) => ({
        check: "exact-pin" as const,
        path: manifest.path,
        problem: `${packageName} uses "${specifier}", not an exact version`,
        fix: `pin ${packageName} to the version the lockfile resolves (npm install --save-exact, pnpm add --save-exact)`,
      })),
  );
}

function isExactSpecifier(specifier: string): boolean {
  if (LOCAL_SPECIFIER_PATTERN.test(specifier)) return true;
  const aliasedVersion = NPM_ALIAS_PATTERN.exec(specifier)?.[1];
  return EXACT_VERSION_PATTERN.test(aliasedVersion ?? specifier);
}

export function findLockfileProblems(manifests: PackageManifest[], trackedPaths: Set<string>): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const manifest of manifests) {
    const manifestDirectory = path.posix.dirname(manifest.path);
    const lockfilesHere = lockfilesIn(manifestDirectory, trackedPaths);
    if (lockfilesHere.length > 1) {
      failures.push({
        check: "lockfile",
        path: manifest.path,
        problem: `${lockfilesHere.join(" and ")} both sit beside it`,
        fix: "keep the lockfile of the package manager CI and deploy use and delete the other",
      });
      continue;
    }
    if (nearestLockfileDirectory(manifestDirectory, trackedPaths) !== null) continue;
    failures.push({
      check: "lockfile",
      path: manifest.path,
      problem: "no committed lockfile covers it",
      fix: "run the package manager's install once and commit the lockfile it writes",
    });
  }
  return failures;
}

function lockfilesIn(directory: string, trackedPaths: Set<string>): string[] {
  return LOCKFILE_NAMES.filter((lockfileName) => trackedPaths.has(directory === "." ? lockfileName : `${directory}/${lockfileName}`));
}

function nearestLockfileDirectory(startDirectory: string, trackedPaths: Set<string>): string | null {
  let directory = startDirectory;
  while (lockfilesIn(directory, trackedPaths).length === 0) {
    if (directory === ".") return null;
    directory = path.posix.dirname(directory);
  }
  return directory;
}

export function findUnfrozenInstalls(files: TrackedFile[]): CheckFailure[] {
  const installConfigs = files.filter((file) => INSTALL_CONFIG_PATTERN.test(file.path));
  const failures: CheckFailure[] = [];
  let hasFrozenInstall = false;
  for (const config of installConfigs) {
    for (const { lineNumber, lineText } of logicalLines(config.text)) {
      for (const installCommand of installCommandsIn(lineText)) {
        if (GLOBAL_INSTALL_PATTERN.test(installCommand.installArguments)) continue;
        if (isFrozenInstall(installCommand)) {
          hasFrozenInstall = true;
          continue;
        }
        failures.push({
          check: "frozen-install",
          path: config.path,
          line: lineNumber,
          problem: `"${installCommand.commandText}" can rewrite the lockfile`,
          fix: frozenInstallFor(installCommand.manager),
        });
      }
    }
  }
  if (hasFrozenInstall || failures.length > 0) return failures;
  return [{
    check: "frozen-install",
    path: ".",
    problem: "no CI workflow or deploy config declares a frozen install",
    fix: "declare the install in CI and in netlify.toml or vercel.json as npm ci, pnpm install --frozen-lockfile, yarn install --immutable, or bun install --frozen-lockfile",
  }];
}

function logicalLines(text: string): { lineNumber: number; lineText: string }[] {
  const physicalLines = text.split("\n");
  const joinedLines: { lineNumber: number; lineText: string }[] = [];
  let pendingStart = -1;
  let pendingText = "";
  physicalLines.forEach((physicalLine, lineIndex) => {
    if (pendingStart === -1) pendingStart = lineIndex;
    const continues = LINE_CONTINUATION_PATTERN.test(`${physicalLine}\n`);
    pendingText += continues ? `${physicalLine.replace(/\\\r?$/, "")} ` : physicalLine;
    if (continues) return;
    joinedLines.push({ lineNumber: pendingStart + 1, lineText: pendingText });
    pendingStart = -1;
    pendingText = "";
  });
  return joinedLines;
}

function installCommandsIn(lineText: string): InstallCommand[] {
  const namedInstalls = [...lineText.matchAll(INSTALL_COMMAND_PATTERN)].map((match) => ({
    manager: match[1] ?? "",
    subcommand: match[2] ?? "",
    installArguments: match[3] ?? "",
    commandText: match[0].trim(),
  }));
  const bareYarnInstalls = [...lineText.matchAll(BARE_YARN_PATTERN)]
    .filter((match) => !NON_INSTALL_YARN_FLAG_PATTERN.test(match[1] ?? ""))
    .map((match) => ({ manager: "yarn", subcommand: "install", installArguments: match[1] ?? "", commandText: match[0].trim() }));
  return [...namedInstalls, ...bareYarnInstalls];
}

function isFrozenInstall({ manager, subcommand, installArguments }: InstallCommand): boolean {
  if (manager === "npm") return subcommand === "ci";
  if (subcommand === "add") return false;
  return FROZEN_FLAG_BY_MANAGER[manager]?.test(installArguments) ?? false;
}

const FROZEN_INSTALL_FIX_BY_MANAGER: Record<string, string> = {
  npm: "use npm ci",
  pnpm: "use pnpm install --frozen-lockfile",
  yarn: "use yarn install --immutable (Yarn 2+) or --frozen-lockfile (Yarn 1)",
  bun: "use bun install --frozen-lockfile",
};

function frozenInstallFor(manager: string): string {
  return FROZEN_INSTALL_FIX_BY_MANAGER[manager] ?? "use the package manager's frozen install";
}
