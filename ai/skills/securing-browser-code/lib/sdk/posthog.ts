import type { CheckFailure, SdkModule, TrackedFile } from "../audit.ts";
import { isTestOrFixture, lineAt } from "../generic.ts";

const EXTERNAL_LOADING_DISABLED_PATTERN = /\bdisable_external_dependency_loading["']?\s*:\s*true\b/;
const SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|html?|astro|vue|svelte)$/;
const NUXT_CONFIG_PATTERN = /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/;
const DEFAULT_IMPORT_PATTERN = /\bimport\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']posthog-js["']/g;
const PROVIDER_OPENING_PATTERN = /<PostHogProvider\b/g;
const NUXT_CONFIG_BLOCK_PATTERN = /\bposthogConfig\s*:\s*\{/g;
const PLACEHOLDER_KEY_PATTERN = /^\s*["'`]</;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|(?<![:"'`])\/\/[^\n]*/g;
const OPTIONS_IDENTIFIER_PATTERN = /^\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*\)?\s*$/;
const PROVIDER_OPTIONS_IDENTIFIER_PATTERN = /\boptions\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/;
const MAX_SPAN_CHARACTERS = 8192;
const CLOSER_BY_OPENER: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

type InitSite = { file: TrackedFile; offset: number; settingsText: string; optionsIdentifier: string | null };

export const posthogModule: SdkModule = {
  name: "posthog",
  packages: ["posthog-js", "@posthog/react", "@posthog/nuxt"],
  secretEnvNames: ["POSTHOG_PERSONAL_API_KEY"],
  secretLiterals: [/\bphx_[A-Za-z0-9]{30,}/],
  check: findRuntimeLoading,
};

function findRuntimeLoading(files: TrackedFile[]): CheckFailure[] {
  const sourceFiles = files.filter((file) => SOURCE_EXTENSION_PATTERN.test(file.path) && !isTestOrFixture(file.path));
  return sourceFiles
    .flatMap((file) => [...initCallSites(file), ...providerSites(file), ...nuxtConfigSites(file)])
    .filter((site) => !disablesExternalLoading(site, sourceFiles))
    .map((site) => ({
      check: "runtime-loading" as const,
      path: site.file.path,
      line: lineAt(site.file.text, site.offset),
      problem: "PostHog may fetch and run extension code from its CDN at runtime",
      fix: "pass disable_external_dependency_loading: true in this init's options (clientConfig for @posthog/nuxt) and import the extensions the app uses from posthog-js/dist (recorder, surveys, ...) so they ship in the bundle",
    }));
}

function initCallSites(file: TrackedFile): InitSite[] {
  const receivers = ["posthog", ...[...file.text.matchAll(DEFAULT_IMPORT_PATTERN)].map((match) => match[1] ?? "")];
  const initCallPattern = new RegExp(`\\b(?:${[...new Set(receivers)].join("|")})\\.init\\(`, "g");
  return [...file.text.matchAll(initCallPattern)].flatMap((match) => {
    const argumentsStart = match.index + match[0].length - 1;
    const argumentsText = withoutComments(file.text.slice(argumentsStart + 1, spanEnd(file.text, argumentsStart) - 1));
    if (PLACEHOLDER_KEY_PATTERN.test(argumentsText)) return [];
    return [{ file, offset: match.index, settingsText: argumentsText, optionsIdentifier: OPTIONS_IDENTIFIER_PATTERN.exec(argumentsText)?.[1] ?? null }];
  });
}

function providerSites(file: TrackedFile): InitSite[] {
  return [...file.text.matchAll(PROVIDER_OPENING_PATTERN)].flatMap((match) => {
    const propsText = withoutComments(file.text.slice(match.index, jsxTagEnd(file.text, match.index)));
    if (!/\bapiKey\s*=/.test(propsText)) return [];
    return [{ file, offset: match.index, settingsText: propsText, optionsIdentifier: PROVIDER_OPTIONS_IDENTIFIER_PATTERN.exec(propsText)?.[1] ?? null }];
  });
}

function nuxtConfigSites(file: TrackedFile): InitSite[] {
  if (!NUXT_CONFIG_PATTERN.test(file.path)) return [];
  return [...file.text.matchAll(NUXT_CONFIG_BLOCK_PATTERN)].map((match) => {
    const blockStart = match.index + match[0].length - 1;
    return { file, offset: match.index, settingsText: withoutComments(file.text.slice(blockStart, spanEnd(file.text, blockStart))), optionsIdentifier: null };
  });
}

function disablesExternalLoading(site: InitSite, sourceFiles: TrackedFile[]): boolean {
  if (EXTERNAL_LOADING_DISABLED_PATTERN.test(site.settingsText)) return true;
  if (site.optionsIdentifier === null) return false;
  const definitionPattern = new RegExp(`\\b(?:const|let|var)\\s+${site.optionsIdentifier}\\b[^=]*=\\s*\\{`, "g");
  const filesInLookupOrder = [site.file, ...sourceFiles.filter((file) => file !== site.file)];
  return filesInLookupOrder.some((file) =>
    [...file.text.matchAll(definitionPattern)].some((definition) => {
      const objectStart = definition.index + definition[0].length - 1;
      return EXTERNAL_LOADING_DISABLED_PATTERN.test(withoutComments(file.text.slice(objectStart, spanEnd(file.text, objectStart))));
    }),
  );
}

function withoutComments(sourceText: string): string {
  return sourceText.replace(COMMENT_PATTERN, "");
}

function spanEnd(text: string, openerIndex: number): number {
  const closers: string[] = [];
  const scanLimit = Math.min(text.length, openerIndex + MAX_SPAN_CHARACTERS);
  for (let index = openerIndex; index < scanLimit; index += 1) {
    const character = text[index] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      index = stringEnd(text, index, scanLimit);
      continue;
    }
    const closer = CLOSER_BY_OPENER[character];
    if (closer !== undefined) closers.push(closer);
    if (character !== closers.at(-1)) continue;
    closers.pop();
    if (closers.length === 0) return index + 1;
  }
  return scanLimit;
}

function stringEnd(text: string, quoteIndex: number, scanLimit: number): number {
  const quote = text[quoteIndex];
  for (let index = quoteIndex + 1; index < scanLimit; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return scanLimit;
}

function jsxTagEnd(text: string, tagStart: number): number {
  const scanLimit = Math.min(text.length, tagStart + MAX_SPAN_CHARACTERS);
  for (let index = tagStart; index < scanLimit; index += 1) {
    if (text[index] === "{") {
      index = spanEnd(text, index) - 1;
      continue;
    }
    if (text[index] === ">") return index + 1;
  }
  return scanLimit;
}
