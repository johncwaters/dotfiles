import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BrandBible, SECTION_NAMES, SECTION_SCHEMAS } from './schema.ts';
import type { SectionName } from './schema.ts';

export type BibleIssue = { path: string; message: string };

export type BibleLoadResult = { ok: true; bible: BrandBible } | { ok: false; issues: BibleIssue[] };

function joinIssuePath(segments: readonly PropertyKey[]): string {
  return segments.map(String).join('.');
}

async function readSectionData(bibleDirectory: string, sectionName: SectionName): Promise<{ data: unknown } | { issue: BibleIssue }> {
  const sectionFile = path.join(bibleDirectory, `${sectionName}.yaml`);
  const sectionText = await readFile(sectionFile, 'utf8').catch(() => undefined);
  if (sectionText === undefined) return { issue: { path: sectionName, message: `missing ${sectionName}.yaml` } };
  try {
    return { data: parseYaml(sectionText) };
  } catch (yamlError) {
    return { issue: { path: sectionName, message: `invalid YAML: ${(yamlError as Error).message.split('\n')[0]}` } };
  }
}

export async function loadBible(bibleDirectory: string): Promise<BibleLoadResult> {
  const issues: BibleIssue[] = [];
  const sectionDataByName: Record<string, unknown> = {};
  await Promise.all(SECTION_NAMES.map(async (sectionName) => {
    const sectionRead = await readSectionData(bibleDirectory, sectionName);
    if ('issue' in sectionRead) {
      issues.push(sectionRead.issue);
      return;
    }
    const sectionParse = SECTION_SCHEMAS[sectionName].safeParse(sectionRead.data);
    if (!sectionParse.success) {
      issues.push(...sectionParse.error.issues.map((issue) => ({ path: joinIssuePath([sectionName, ...issue.path]), message: issue.message })));
      return;
    }
    sectionDataByName[sectionName] = sectionParse.data;
  }));
  if (issues.length > 0) return { ok: false, issues: issues.sort((left, right) => left.path.localeCompare(right.path)) };
  const bibleParse = BrandBible.safeParse(sectionDataByName);
  if (!bibleParse.success) return { ok: false, issues: bibleParse.error.issues.map((issue) => ({ path: joinIssuePath(issue.path), message: issue.message })) };
  return { ok: true, bible: bibleParse.data };
}

async function main(commandArguments: string[]): Promise<void> {
  const bibleDirectory = commandArguments[0];
  if (!bibleDirectory) {
    process.stderr.write('usage: node load.ts <brand-bible directory>\n');
    process.exitCode = 2;
    return;
  }
  const loadResult = await loadBible(path.resolve(bibleDirectory));
  if (loadResult.ok) {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(loadResult)}\n`);
  process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
