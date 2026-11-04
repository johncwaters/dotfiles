import path from "node:path";
import type { CheckFailure, PackageManifest, SdkModule, TrackedFile } from "./audit.ts";

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

const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".astro", ".vue", ".svelte", ".jsx", ".tsx", ".hbs", ".ejs", ".njk", ".liquid", ".php", ".erb"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const TEST_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", "spec", "fixtures", "__fixtures__", "node_modules"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^/]+$/;
const MAX_SCRIPT_TAG_CHARACTERS = 2048;
const SCRIPT_TAG_OPENING = "<script";
const CROSS_ORIGIN_SRC_PATTERN = /\bsrc\s*=\s*\{?\s*["'`]?(?:https?:)?\/\//i;
const INTEGRITY_ATTRIBUTE_PATTERN = /\bintegrity\s*=/i;
const CROSSORIGIN_ATTRIBUTE_PATTERN = /\bcross[oO]rigin\b/i;
const POSTHOG_SNIPPET_PATTERN = /\/static\/(?:\d+\/)?(?:array|loader)\.js\b/;
const SCRIPT_ELEMENT_CREATION_PATTERN = /createElement\(\s*["'`]script["'`]\s*\)/;
const SNIPPET_WINDOW_CHARACTERS = 2048;
const POLICY_HEADER_PATTERN = /Content-Security-Policy(?:-Report-Only)?\b|\bcontentSecurityPolicy\b(?!\s*:\s*false)/g;
const REPORT_ONLY_PATTERN = /^Content-Security-Policy-Report-Only|reportOnly\s*:\s*true/;
const MAX_POLICY_CHARACTERS = 2048;
const ROOT_DEPLOY_CONFIG_NAMES = new Set(["netlify.toml", "vercel.json", "_headers"]);
const NONCE_OR_HASH_PATTERN = /'(?:nonce-|sha(?:256|384|512)-)/i;

type ScriptTag = { text: string; offset: number };
type PolicyDeclaration = { path: string; line: number; isReportOnly: boolean; policyText: string; fileText: string };

export function isTestOrFixture(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath) || filePath.split("/").slice(0, -1).some((directoryName) => TEST_DIRECTORY_NAMES.has(directoryName));
}

function extensionOf(filePath: string): string {
  return path.posix.extname(filePath).toLowerCase();
}

export function crossOriginScriptTags(file: TrackedFile): ScriptTag[] {
  if (!MARKUP_EXTENSIONS.has(extensionOf(file.path)) || isTestOrFixture(file.path)) return [];
  return scriptTagsIn(file.text).filter((tag) => CROSS_ORIGIN_SRC_PATTERN.test(tag.text));
}

export function hasPosthogSnippet(file: TrackedFile): boolean {
  return posthogSnippetOffset(file) !== -1;
}

function posthogSnippetOffset(file: TrackedFile): number {
  const extension = extensionOf(file.path);
  const isPageSource = MARKUP_EXTENSIONS.has(extension) || SCRIPT_EXTENSIONS.has(extension);
  if (!isPageSource || isTestOrFixture(file.path) || !SCRIPT_ELEMENT_CREATION_PATTERN.test(file.text)) return -1;
  return file.text.search(POSTHOG_SNIPPET_PATTERN);
}

function scriptTagsIn(markup: string): ScriptTag[] {
  const lowercaseMarkup = markup.toLowerCase();
  const tags: ScriptTag[] = [];
  let tagStart = lowercaseMarkup.indexOf(SCRIPT_TAG_OPENING);
  while (tagStart !== -1) {
    const nextTagStart = lowercaseMarkup.indexOf(SCRIPT_TAG_OPENING, tagStart + 1);
    const tagEnd = markup.indexOf(">", tagStart);
    const scanEnd = Math.min(tagEnd === -1 ? markup.length : tagEnd, nextTagStart === -1 ? markup.length : nextTagStart, tagStart + MAX_SCRIPT_TAG_CHARACTERS);
    tags.push({ text: markup.slice(tagStart, scanEnd), offset: tagStart });
    tagStart = nextTagStart;
  }
  return tags;
}

export function lineAt(text: string, offset: number): number {
  let lineNumber = 1;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) lineNumber += 1;
  return lineNumber;
}

export function findMissingIntegrity(files: TrackedFile[]): CheckFailure[] {
  const tagFailures = files.flatMap((file) =>
    crossOriginScriptTags(file).flatMap((tag) => {
      const missingAttributes = [
        INTEGRITY_ATTRIBUTE_PATTERN.test(tag.text) ? null : "integrity",
        CROSSORIGIN_ATTRIBUTE_PATTERN.test(tag.text) ? null : "crossorigin",
      ].filter((attribute) => attribute !== null);
      if (missingAttributes.length === 0) return [];
      return [{
        check: "script-integrity" as const,
        path: file.path,
        line: lineAt(file.text, tag.offset),
        problem: `cross-origin script lacks ${missingAttributes.join(" and ")}`,
        fix: 'bundle the script, or pin its exact URL and add integrity="sha384-..." crossorigin="anonymous"',
      }];
    }),
  );
  const snippetFailures = files.flatMap((file) => {
    const snippetOffset = posthogSnippetOffset(file);
    if (snippetOffset === -1) return [];
    const snippetWindow = file.text.slice(Math.max(0, snippetOffset - SNIPPET_WINDOW_CHARACTERS), snippetOffset + SNIPPET_WINDOW_CHARACTERS);
    if (INTEGRITY_ATTRIBUTE_PATTERN.test(snippetWindow)) return [];
    return [{
      check: "script-integrity" as const,
      path: file.path,
      line: lineAt(file.text, snippetOffset),
      problem: "PostHog snippet loads its loader without subresource integrity",
      fix: "install posthog-js from npm, or use the snippet from posthog-js 1.445.0 or later with the pinned loader.js and array.js hashes from its integrity.json",
    }];
  });
  return [...tagFailures, ...snippetFailures];
}

export function findCspProblems(files: TrackedFile[], browserCodeDirectories: string[]): CheckFailure[] {
  const policyFiles = files.filter(canDeclarePolicy);
  return browserCodeDirectories.flatMap((directory) => {
    const declarations = policyFiles.filter((file) => coversDirectory(file.path, directory)).flatMap(policyDeclarations);
    const enforcedDeclarations = declarations.filter((declaration) => !declaration.isReportOnly);
    if (enforcedDeclarations.length > 0) return enforcedDeclarations.flatMap(unsafeScriptSourceFailure);
    const reportOnlyDeclaration = declarations[0];
    return [{
      check: "csp-missing" as const,
      path: reportOnlyDeclaration?.path ?? directory,
      ...(reportOnlyDeclaration === undefined ? {} : { line: reportOnlyDeclaration.line }),
      problem: reportOnlyDeclaration === undefined ? "no Content-Security-Policy covers the browser code here" : "the Content-Security-Policy is report-only, so it blocks nothing",
      fix: "send an enforced Content-Security-Policy header (netlify.toml, _headers, vercel.json, or server code) or a <meta http-equiv> tag, with script-src and connect-src listing only the origins the page needs",
    }];
  });
}

function canDeclarePolicy(file: TrackedFile): boolean {
  if (isTestOrFixture(file.path)) return false;
  const extension = extensionOf(file.path);
  return ROOT_DEPLOY_CONFIG_NAMES.has(path.posix.basename(file.path)) || MARKUP_EXTENSIONS.has(extension) || SCRIPT_EXTENSIONS.has(extension);
}

function coversDirectory(filePath: string, directory: string): boolean {
  if (directory === "." || filePath.startsWith(`${directory}/`)) return true;
  return path.posix.dirname(filePath) === "." && ROOT_DEPLOY_CONFIG_NAMES.has(filePath);
}

function policyDeclarations(file: TrackedFile): PolicyDeclaration[] {
  return [...file.text.matchAll(POLICY_HEADER_PATTERN)].map((match) => {
    const policyText = file.text.slice(match.index, match.index + MAX_POLICY_CHARACTERS);
    return { path: file.path, line: lineAt(file.text, match.index), isReportOnly: REPORT_ONLY_PATTERN.test(policyText), policyText, fileText: file.text };
  });
}

function unsafeScriptSourceFailure(declaration: PolicyDeclaration): CheckFailure[] {
  const scriptSources = directiveSources(declaration, ["script-src", "scriptSrc"]) ?? directiveSources(declaration, ["default-src", "defaultSrc"]);
  const location = { check: "csp-unsafe" as const, path: declaration.path, line: declaration.line };
  if (scriptSources === null) {
    return [{ ...location, problem: "the policy sets neither script-src nor default-src, so scripts load from anywhere", fix: "add script-src listing only the origins the page needs" }];
  }
  const elementSources = directiveSources(declaration, ["script-src-elem", "scriptSrcElem"]) ?? scriptSources;
  const grantsUnsafeEval = scriptSources.includes("'unsafe-eval'");
  const grantsUnsafeInline = [scriptSources, elementSources].some((sources) => sources.includes("'unsafe-inline'") && !NONCE_OR_HASH_PATTERN.test(sources));
  const grants = [grantsUnsafeInline ? "'unsafe-inline'" : null, grantsUnsafeEval ? "'unsafe-eval'" : null].filter((grant) => grant !== null);
  if (grants.length === 0) return [];
  return [{ ...location, problem: `script-src grants ${grants.join(" and ")}`, fix: "drop it; allow inline scripts with a per-response nonce or a sha256 hash, and replace code that needs eval" }];
}

function directiveSources(declaration: PolicyDeclaration, directiveNames: string[]): string | null {
  const directivePatterns = directiveNames.flatMap((directiveName) => [
    new RegExp(`\\b${directiveName}\\s([^;"\`\\n]*)`, "i"),
    new RegExp(`["']?\\b${directiveName}["']?\\s*:\\s*\\[([^\\]]*)\\]`),
  ]);
  for (const searchedText of [declaration.policyText, declaration.fileText]) {
    for (const directivePattern of directivePatterns) {
      const sources = directivePattern.exec(searchedText)?.[1];
      if (sources !== undefined) return sources;
    }
  }
  return null;
}

const SECRET_SCAN_EXCLUDED_PATTERN = /\.example(?:\.[^/]+)?$|\.lock$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export function findSecretLiterals(files: TrackedFile[], sdkModules: SdkModule[]): CheckFailure[] {
  const scannedFiles = files.filter((file) => !isTestOrFixture(file.path) && !SECRET_SCAN_EXCLUDED_PATTERN.test(file.path));
  const ownerNamesByPattern = new Map<RegExp, string[]>();
  for (const sdkModule of sdkModules) {
    for (const secretPattern of sdkModule.secretLiterals) ownerNamesByPattern.set(secretPattern, [...(ownerNamesByPattern.get(secretPattern) ?? []), sdkModule.name]);
  }
  return [...ownerNamesByPattern].flatMap(([secretPattern, ownerNames]) =>
    scannedFiles.flatMap((file) => {
      const match = new RegExp(secretPattern.source, secretPattern.flags.replace("g", "")).exec(file.text);
      if (match === null) return [];
      return [{
        check: "secret-literal" as const,
        path: file.path,
        line: lineAt(file.text, match.index),
        problem: `a ${ownerNames.join(" or ")} secret (${match[0].slice(0, 8)}...) is committed`,
        fix: "revoke it now, since it is in git history, then read the replacement from a server-side environment variable",
      }];
    }),
  );
}

const CLIENT_ENV_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "PUBLIC_", "VITE_", "REACT_APP_", "VUE_APP_", "GATSBY_"];
const PUBLIC_SECRET_EXCLUDED_PATTERN = /\.(?:md|mdx|lock)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export function findPublicSecrets(files: TrackedFile[], sdkModules: SdkModule[]): CheckFailure[] {
  const scannedFiles = files.filter((file) => !isTestOrFixture(file.path) && !PUBLIC_SECRET_EXCLUDED_PATTERN.test(file.path));
  return sdkModules.flatMap((sdkModule) => {
    if (sdkModule.secretEnvNames.length === 0) return [];
    const publicSecretPattern = new RegExp(`(?<![A-Za-z0-9_])(?:${CLIENT_ENV_PREFIXES.join("|")})(?:${sdkModule.secretEnvNames.join("|")})(?![A-Za-z0-9_])`);
    return scannedFiles.flatMap((file) => {
      const match = publicSecretPattern.exec(file.text);
      if (match === null) return [];
      return [{
        check: "public-secret" as const,
        path: file.path,
        line: lineAt(file.text, match.index),
        problem: `${match[0]} exposes a server-only ${sdkModule.name} secret, since its prefix inlines it into the browser bundle`,
        fix: "rename it without the client prefix, read it only in server code, and rotate it if a build has shipped it",
      }];
    });
  });
}
