import fs from "node:fs";
import path from "node:path";
import { Git, type GitResult } from "../../landing/lib/git.ts";
import { findLockfileProblems, findUnfrozenInstalls, findUnpinnedDependencies } from "./generic.ts";
import { posthogModule } from "./sdk/posthog.ts";

export type CheckId =
  | "exact-pin"
  | "lockfile"
  | "frozen-install"
  | "script-integrity"
  | "csp-missing"
  | "csp-unsafe"
  | "public-secret"
  | "runtime-loading"
  | "secret-literal"
  | "waiver-reason";
export type CheckFailure = { check: CheckId; path: string; line?: number; problem: string; fix: string };
export type TrackedFile = { path: string; text: string };
export type PackageManifest = { path: string; dependencies: Record<string, string> };
export type SdkModule = {
  name: string;
  packages: string[];
  secretEnvNames: string[];
  secretLiterals: RegExp[];
  check?(files: TrackedFile[]): CheckFailure[];
};
type RepoListing = { trackedPaths: Set<string>; files: TrackedFile[] };
export type AuditReport = { applies: boolean; sdks: string[]; failures: CheckFailure[]; waived: CheckFailure[] };
type Waiver = { check: string; paths: string; reason: string };

const SDK_MODULES: SdkModule[] = [posthogModule];
const WAIVER_FILE = ".browser-sdk-waivers.json";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_TAG_CHARACTERS = 2048;
const SCRIPT_TAG_OPENING = "<script";
const CROSS_ORIGIN_SRC_PATTERN = /\bsrc\s*=\s*\{?\s*["'`]?(?:https?:)?\/\//i;
const REPOSITORY_OVERRIDE_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];
const DEPENDENCY_FIELDS = ["devDependencies", "optionalDependencies", "dependencies"];
const NPM_ALIAS_TARGET_PATTERN = /^npm:((?:@[^/@]+\/)?[^@]+)@/;
const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".astro", ".vue", ".svelte", ".jsx", ".tsx", ".hbs", ".ejs", ".njk", ".liquid", ".php", ".erb"]);

export function auditBrowserCode(repoRoot: string): AuditReport {
  const { trackedPaths, files } = readTrackedFiles(repoRoot);
  const manifests = readPackageManifests(files);
  const dependencyNames = new Set(manifests.flatMap((manifest) => Object.entries(manifest.dependencies).flatMap(installedPackageNames)));
  const usedModules = SDK_MODULES.filter((sdkModule) => sdkModule.packages.some((packageName) => usesPackage(dependencyNames, packageName)));
  const loadsCrossOriginScript = files.some((file) => isMarkupFile(file.path) && hasCrossOriginScript(file.text));
  if (usedModules.length === 0 && !loadsCrossOriginScript) {
    return { applies: false, sdks: [], failures: [], waived: [] };
  }
  const failures = [
    ...findUnpinnedDependencies(manifests),
    ...findLockfileProblems(manifests, trackedPaths),
    ...findUnfrozenInstalls(files),
    ...usedModules.flatMap((sdkModule) => sdkModule.check?.(files) ?? []),
  ];
  const { waivers, waiverFailures } = readWaivers(files);
  const waived = failures.filter((failure) => waivers.some((waiver) => waiverCovers(waiver, failure)));
  const unwaived = failures.filter((failure) => !waived.includes(failure));
  return { applies: true, sdks: usedModules.map((sdkModule) => sdkModule.name), failures: [...unwaived, ...waiverFailures], waived };
}

export function formatFailure(failure: CheckFailure): string {
  const location = failure.line === undefined ? failure.path : `${failure.path}:${failure.line}`;
  return `FAIL ${failure.check} ${location} ${failure.problem}. Fix: ${failure.fix}`;
}

function isMarkupFile(filePath: string): boolean {
  return MARKUP_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

export function runGitIn(directory: string, gitArguments: string[]): GitResult {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !REPOSITORY_OVERRIDE_VARIABLES.includes(entry[0])),
  );
  return new Git(directory).run(gitArguments, { env: environment, replacesInheritedEnv: true });
}

function hasCrossOriginScript(markup: string): boolean {
  const lowercaseMarkup = markup.toLowerCase();
  let tagStart = lowercaseMarkup.indexOf(SCRIPT_TAG_OPENING);
  while (tagStart !== -1) {
    const nextTagStart = lowercaseMarkup.indexOf(SCRIPT_TAG_OPENING, tagStart + 1);
    const tagEnd = markup.indexOf(">", tagStart);
    const scanEnd = Math.min(tagEnd === -1 ? markup.length : tagEnd, nextTagStart === -1 ? markup.length : nextTagStart, tagStart + MAX_SCRIPT_TAG_CHARACTERS);
    if (CROSS_ORIGIN_SRC_PATTERN.test(markup.slice(tagStart, scanEnd))) return true;
    tagStart = nextTagStart;
  }
  return false;
}

function readTrackedFiles(repoRoot: string): RepoListing {
  const listing = runGitIn(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listing.code !== 0) throw new Error(`git ls-files failed in ${repoRoot}: ${listing.stderr.trim()}`);
  const trackedPaths = new Set(listing.stdout.split("\0").filter(Boolean));
  const files = [...trackedPaths].flatMap((trackedPath) => {
    const text = readTextFile(path.join(repoRoot, trackedPath));
    return text === null ? [] : [{ path: trackedPath, text }];
  });
  return { trackedPaths, files };
}

function readTextFile(absolutePath: string): string | null {
  try {
    const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.size > MAX_TEXT_BYTES) return null;
    const text = fs.readFileSync(absolutePath, "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function readPackageManifests(files: TrackedFile[]): PackageManifest[] {
  return files
    .filter((file) => path.posix.basename(file.path) === "package.json" && !file.path.split("/").includes("node_modules"))
    .flatMap((file) => {
      const manifest = parseJson(file.text);
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
      const manifestFields = manifest as Record<string, unknown>;
      const dependencies: Record<string, string> = Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => stringRecord(manifestFields[field])));
      return [{ path: file.path, dependencies }];
    });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function installedPackageNames([dependencyName, specifier]: [string, string]): string[] {
  const aliasTarget = NPM_ALIAS_TARGET_PATTERN.exec(specifier)?.[1];
  return aliasTarget === undefined ? [dependencyName] : [dependencyName, aliasTarget];
}

function usesPackage(dependencyNames: Set<string>, packageName: string): boolean {
  if (!packageName.endsWith("/*")) return dependencyNames.has(packageName);
  const scope = packageName.slice(0, -1);
  return [...dependencyNames].some((dependencyName) => dependencyName.startsWith(scope));
}

function readWaivers(files: TrackedFile[]): { waivers: Waiver[]; waiverFailures: CheckFailure[] } {
  const waiverFile = files.find((file) => file.path === WAIVER_FILE);
  if (waiverFile === undefined) return { waivers: [], waiverFailures: [] };
  const entries = parseJson(waiverFile.text);
  if (!Array.isArray(entries)) {
    return { waivers: [], waiverFailures: [waiverFailure("is not a JSON array of waivers")] };
  }
  const waivers: Waiver[] = [];
  const waiverFailures: CheckFailure[] = [];
  entries.forEach((entry, index) => {
    if (isWaiver(entry)) {
      waivers.push(entry);
      return;
    }
    waiverFailures.push(waiverFailure(`entry ${index + 1} needs a check, a paths glob, and a non-empty reason`));
  });
  return { waivers, waiverFailures };
}

function isWaiver(entry: unknown): entry is Waiver {
  if (typeof entry !== "object" || entry === null) return false;
  const { check, paths, reason } = entry as Record<string, unknown>;
  return typeof check === "string" && typeof paths === "string" && typeof reason === "string" && reason.trim() !== "";
}

function waiverFailure(problem: string): CheckFailure {
  return { check: "waiver-reason", path: WAIVER_FILE, problem, fix: 'give every waiver { "check", "paths", "reason" } with the reason it is safe' };
}

function waiverCovers(waiver: Waiver, failure: CheckFailure): boolean {
  return waiver.check === failure.check && path.posix.matchesGlob(failure.path, waiver.paths);
}
