import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { targetFinding } from './bible/targets.ts';
import type { Finding, FindingKind, UntargetedFinding } from './bible/targets.ts';
import { addFinding, addWholeFileFinding, createCollector, imageRoleHint, isFontFile, isImageFile, rasterDimensions } from './findings.ts';
import type { FindingCollector } from './findings.ts';
import { scanCss } from './parse-css.ts';

export type ScanContext = { productNames: string[]; tailwindTextNames: Set<string> };

type TextScanner = { phase: 1 | 2; scan: (collector: FindingCollector, text: string, context: ScanContext) => void };

type CensusOptions = { repoDirectory: string; summary: boolean; outFile?: string; includes: string[]; excludes: string[] };

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

const NOISE_FILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'composer.lock',
  'Gemfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Pipfile.lock', 'flake.lock',
]);
const NOISE_DIRECTORY_PATTERN = /(?:^|\/)(?:node_modules|dist|build|vendor|brand-bible|\.git)\//;

const LICENSE_PATTERN = /(?:^|\/)(?:licen[cs]e|notice|copying)(?:[.-][^/]*)?$|(?:^|\/)[^/]*ofl[^/]*\.txt$/i;
const LOCALE_PATTERN = /(?:^|\/)(?:locales?|i18n|l10n|lang|langs|translations)\/|\.(?:po|pot|xliff|xlf|arb)$|(?:^|\/)messages\.[a-z]{2}(?:[-_][a-z]{2})?\.json$/i;
const CODEOWNERS_PATTERN = /(?:^|\/)CODEOWNERS$/;

export const TEXT_SCANNERS: Record<string, TextScanner> = {
  '.css': { phase: 1, scan: (collector, text, context) => scanStylesheet(collector, text, context, 'css') },
  '.pcss': { phase: 1, scan: (collector, text, context) => scanStylesheet(collector, text, context, 'css') },
  '.postcss': { phase: 1, scan: (collector, text, context) => scanStylesheet(collector, text, context, 'css') },
  '.scss': { phase: 1, scan: (collector, text, context) => scanStylesheet(collector, text, context, 'scss') },
  '.less': { phase: 1, scan: (collector, text, context) => scanStylesheet(collector, text, context, 'scss') },
};

function scanStylesheet(collector: FindingCollector, text: string, context: ScanContext, syntax: 'css' | 'scss'): void {
  const { tailwindTextNames } = scanCss(collector, text, { syntax });
  for (const name of tailwindTextNames) context.tailwindTextNames.add(name);
}

function isNoiseFile(file: string): boolean {
  const baseName = path.posix.basename(file);
  return NOISE_FILE_NAMES.has(baseName) || /^changelog/i.test(baseName) || /\.min\./i.test(baseName) || NOISE_DIRECTORY_PATTERN.test(file);
}

const execFileAsync = promisify(execFile);

async function listGitFiles(repoDirectory: string): Promise<string[] | undefined> {
  const gitListing = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], {
    cwd: repoDirectory,
    maxBuffer: 256 * 1024 * 1024,
  }).catch(() => undefined);
  if (!gitListing) return undefined;
  return gitListing.stdout.split('\0').filter(Boolean);
}

async function walkFiles(repoDirectory: string): Promise<string[]> {
  const entries = await readdir(repoDirectory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.relative(repoDirectory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

export async function listRepoFiles(repoDirectory: string, includes: string[], excludes: string[]): Promise<string[]> {
  const allFiles = (await listGitFiles(repoDirectory)) ?? (await walkFiles(repoDirectory));
  return allFiles
    .filter((file) => !isNoiseFile(file))
    .filter((file) => includes.length === 0 || includes.some((glob) => path.posix.matchesGlob(file, glob)))
    .filter((file) => !excludes.some((glob) => path.posix.matchesGlob(file, glob)))
    .sort();
}

function sha1Of(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function hasNulByte(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function addPathRuleFindings(collector: FindingCollector, file: string): boolean {
  const baseName = path.posix.basename(file);
  if (LICENSE_PATTERN.test(file)) addWholeFileFinding(collector, 'license-file', file, baseName.toLowerCase(), { name: baseName });
  if (LOCALE_PATTERN.test(file)) addWholeFileFinding(collector, 'locale-file', file, file.toLowerCase(), {});
  return LICENSE_PATTERN.test(file) || LOCALE_PATTERN.test(file);
}

function addCodeownersFindings(collector: FindingCollector, text: string): void {
  text.split('\n').forEach((lineText, index) => {
    const rule = lineText.trim();
    if (!rule || rule.startsWith('#')) return;
    const [pattern = '', ...owners] = rule.split(/\s+/);
    addFinding(collector, 'codeowners', { line: index + 1, column: 1 }, rule, pattern, { owners: owners.join(' ') });
  });
}

function addBinaryAssetFinding(collector: FindingCollector, file: string, extension: string, bytes: Uint8Array): void {
  const detail = { bytes: bytes.length, sha1: sha1Of(bytes) };
  if (isFontFile(extension)) {
    addWholeFileFinding(collector, 'font-file', file, path.posix.basename(file).toLowerCase(), detail);
    return;
  }
  const dimensions = rasterDimensions(bytes, extension);
  const sizeDetail = dimensions ? { width: dimensions.width, height: dimensions.height } : {};
  addWholeFileFinding(collector, 'image-asset', file, detail.sha1, { ...detail, ...sizeDetail, role: imageRoleHint(file), format: extension.slice(1) });
}

function addSkipped(collector: FindingCollector, file: string, reason: string): void {
  addWholeFileFinding(collector, 'skipped', file, reason, { reason });
}

function firstLineOf(message: string): string {
  return message.split('\n')[0] ?? message;
}

export async function scanFile(repoDirectory: string, file: string, context: ScanContext): Promise<UntargetedFinding[]> {
  const absolutePath = path.join(repoDirectory, file);
  const extension = path.posix.extname(file).toLowerCase();
  const scanner = TEXT_SCANNERS[extension];
  const collector = createCollector(file, '');
  const isPathRuled = addPathRuleFindings(collector, file);
  const isAsset = isFontFile(extension) || isImageFile(extension);
  const isCodeowners = CODEOWNERS_PATTERN.test(file);
  if (!scanner && !isAsset && !isCodeowners) {
    if (!isPathRuled) addSkipped(collector, file, 'no-parser');
    return collector.findings;
  }
  const fileStat = await lstat(absolutePath).catch(() => undefined);
  if (fileStat?.isSymbolicLink()) {
    addSkipped(collector, file, 'symlink');
    return collector.findings;
  }
  if (!fileStat?.isFile()) {
    addSkipped(collector, file, 'missing');
    return collector.findings;
  }
  if (fileStat.size > (isAsset ? MAX_ASSET_BYTES : MAX_TEXT_BYTES)) {
    addSkipped(collector, file, 'too-large');
    return collector.findings;
  }
  const bytes = await readFile(absolutePath).catch((readError: Error & { code?: string }) => readError);
  if (bytes instanceof Error) {
    addSkipped(collector, file, `unreadable: ${bytes.code ?? firstLineOf(bytes.message)}`);
    return collector.findings;
  }
  if (isAsset) {
    addBinaryAssetFinding(collector, file, extension, bytes);
    if (!scanner) return collector.findings;
  }
  if (hasNulByte(bytes)) {
    addSkipped(collector, file, 'binary');
    return collector.findings;
  }
  const text = bytes.toString('utf8');
  const textCollector = createCollector(file, text);
  textCollector.findings.push(...collector.findings);
  if (isCodeowners) addCodeownersFindings(textCollector, text);
  if (!scanner) return textCollector.findings;
  try {
    scanner.scan(textCollector, text, context);
  } catch (parseError) {
    addSkipped(textCollector, file, `parse-error: ${firstLineOf((parseError as Error).message)}`);
  }
  return textCollector.findings;
}

async function mapWithConcurrency<Input, Output>(inputs: Input[], limit: number, mapper: (input: Input) => Promise<Output>): Promise<Output[]> {
  const outputs: Output[] = new Array(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (let index = nextIndex++; index < inputs.length; index = nextIndex++) outputs[index] = await mapper(inputs[index] as Input);
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return outputs;
}

function compareFindings(left: Finding, right: Finding): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.column !== right.column) return left.column - right.column;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0;
}

function phaseOf(file: string): 1 | 2 {
  return TEXT_SCANNERS[path.posix.extname(file).toLowerCase()]?.phase ?? 2;
}

export async function runCensus(repoDirectory: string, options: { includes: string[]; excludes: string[] }): Promise<Finding[]> {
  const files = await listRepoFiles(repoDirectory, options.includes, options.excludes);
  const context: ScanContext = { productNames: [], tailwindTextNames: new Set() };
  const concurrency = availableParallelism() * 4;
  const scanPhase = (phase: 1 | 2) => mapWithConcurrency(files.filter((file) => phaseOf(file) === phase), concurrency, (file) => scanFile(repoDirectory, file, context));
  const stylesheetFindings = await scanPhase(1);
  const otherFindings = await scanPhase(2);
  return [...stylesheetFindings, ...otherFindings].flat().map(targetFinding).sort(compareFindings);
}

type SummaryGroup = { normalized: string; count: number; files: string[] };

export function summarize(findings: Finding[]): { totals: Partial<Record<FindingKind, number>>; byKind: Partial<Record<FindingKind, SummaryGroup[]>> } {
  const groupsByKind = new Map<FindingKind, Map<string, { count: number; files: Set<string> }>>();
  for (const finding of findings) {
    const groups = groupsByKind.get(finding.kind) ?? new Map<string, { count: number; files: Set<string> }>();
    groupsByKind.set(finding.kind, groups);
    const group = groups.get(finding.normalized) ?? { count: 0, files: new Set<string>() };
    groups.set(finding.normalized, group);
    group.count += 1;
    group.files.add(finding.file);
  }
  const totals: Partial<Record<FindingKind, number>> = {};
  const byKind: Partial<Record<FindingKind, SummaryGroup[]>> = {};
  for (const [kind, groups] of [...groupsByKind].sort(([left], [right]) => (left < right ? -1 : 1))) {
    totals[kind] = [...groups.values()].reduce((sum, group) => sum + group.count, 0);
    byKind[kind] = [...groups]
      .map(([normalized, group]) => ({ normalized, count: group.count, files: [...group.files].sort() }))
      .sort((left, right) => right.count - left.count || (left.normalized < right.normalized ? -1 : 1));
  }
  return { totals, byKind };
}

function parseArguments(commandArguments: string[]): CensusOptions | string {
  const options: CensusOptions = { repoDirectory: '.', summary: false, includes: [], excludes: [] };
  const valueFlags: Record<string, (value: string) => void> = {
    '--out': (value) => { options.outFile = value; },
    '--include': (value) => { options.includes.push(value); },
    '--exclude': (value) => { options.excludes.push(value); },
  };
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] ?? '';
    if (argument === '--summary') {
      options.summary = true;
      continue;
    }
    const setValue = valueFlags[argument];
    if (setValue) {
      const value = commandArguments[index + 1];
      if (value === undefined) return `${argument} needs a value`;
      setValue(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) return `unknown flag ${argument}`;
    options.repoDirectory = argument;
  }
  return options;
}

async function main(commandArguments: string[]): Promise<void> {
  const options = parseArguments(commandArguments);
  if (typeof options === 'string') {
    process.stderr.write(`${options}\nusage: node census.ts [repoDir=.] [--summary] [--out <file>] [--include <glob>]... [--exclude <glob>]...\n`);
    process.exitCode = 2;
    return;
  }
  const findings = await runCensus(path.resolve(options.repoDirectory), options);
  const output = options.summary ? `${JSON.stringify(summarize(findings), null, 2)}\n` : findings.map((finding) => `${JSON.stringify(finding)}\n`).join('');
  if (options.outFile) {
    await writeFile(options.outFile, output);
    return;
  }
  process.stdout.write(output);
}

if (import.meta.main) await main(process.argv.slice(2));
