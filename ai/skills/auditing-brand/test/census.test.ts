import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadBible } from '../bible/load.ts';
import { BIBLE_TARGETS } from '../bible/targets.ts';
import type { Finding } from '../bible/targets.ts';

const fixtureRepository = fileURLToPath(new URL('./fixture-repo/', import.meta.url));
const fixtureBible = path.join(fixtureRepository, 'brand-bible');

async function copyFixtureBible(context: test.TestContext): Promise<string> {
  const scratchDirectory = await mkdtemp(path.join(os.tmpdir(), 'auditing-brand-'));
  context.after(() => rm(scratchDirectory, { recursive: true, force: true }));
  const bibleCopy = path.join(scratchDirectory, 'brand-bible');
  await cp(fixtureBible, bibleCopy, { recursive: true });
  return bibleCopy;
}

test('the fixture bible loads, and a missing section, an unknown token and a failing contrast pair are refused by field path', async (context) => {
  const validLoad = await loadBible(fixtureBible);
  assert.equal(validLoad.ok, true);

  const brokenBible = await copyFixtureBible(context);
  await rm(path.join(brokenBible, 'motion.yaml'));
  const colorFile = path.join(brokenBible, 'color.yaml');
  const colorText = await readFile(colorFile, 'utf8');
  await writeFile(colorFile, colorText.replace('foreground: text', 'foreground: missing-token'));
  const missingSectionLoad = await loadBible(brokenBible);
  assert.deepEqual(missingSectionLoad, { ok: false, issues: [{ path: 'motion', message: 'missing motion.yaml' }] });

  await cp(path.join(fixtureBible, 'motion.yaml'), path.join(brokenBible, 'motion.yaml'));
  const unknownTokenLoad = await loadBible(brokenBible);
  assert.deepEqual(unknownTokenLoad, { ok: false, issues: [{ path: 'color.pairs.0.foreground', message: 'names no color token: missing-token' }] });

  await writeFile(colorFile, colorText.replace('value: "#e8e8f0"', 'value: "#16161f"'));
  const lowContrastLoad = await loadBible(brokenBible);
  assert.equal(lowContrastLoad.ok, false);
  assert.match(JSON.stringify(lowContrastLoad), /"path":"color\.pairs\.0","message":"contrast 1\.\d+ is below 4\.5"/);
});

const censusScript = fileURLToPath(new URL('../census.ts', import.meta.url));

async function runCensusCli(...censusArguments: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [censusScript, fixtureRepository, ...censusArguments]);
  return stdout;
}

function findingsWhere(findings: Finding[], kind: string, file: string): Finding[] {
  return findings.filter((finding) => finding.kind === kind && finding.file === file);
}

test('the census lists every stylesheet, asset and path-rule surface of the fixture repo as sorted, targeted JSONL', async () => {
  const findings: Finding[] = (await runCensusCli()).trim().split('\n').map((line) => JSON.parse(line));
  const sortKeys = findings.map((finding) => [finding.file, String(finding.line).padStart(6, '0'), String(finding.column).padStart(6, '0'), finding.kind].join('|'));
  assert.deepEqual(sortKeys, [...sortKeys].sort());
  assert.ok(findings.every((finding) => BIBLE_TARGETS.includes(finding.target)));
  assert.ok(findings.every((finding) => !finding.file.startsWith('brand-bible/')));

  const tokenColors = findingsWhere(findings, 'color', 'styles/tokens.css').map((finding) => `${finding.raw}=${finding.normalized}`);
  assert.ok(tokenColors.includes('oklch(0.7217 0.1767 305.5)=#c084fc'));
  assert.ok(tokenColors.includes('rgb(232 232 240)=#e8e8f0'));
  assert.ok(tokenColors.includes('hsl(270 95% 75% / 50%)=#bf83fc80'));
  assert.deepEqual(findingsWhere(findings, 'color', 'styles/panel.scss').map((finding) => finding.normalized), ['#c084fc']);
  assert.deepEqual(findingsWhere(findings, 'color-expression', 'styles/tokens.css').map((finding) => finding.normalized.split('(')[0]), ['--accent', 'linear-gradient', 'color-mix', 'hsl']);

  const sizes = [...findingsWhere(findings, 'font-size', 'styles/tokens.css'), ...findingsWhere(findings, 'font-size', 'styles/panel.scss')]
    .map((finding) => `${finding.line}:${finding.normalized}:${finding.detail?.from ?? 'declaration'}:${finding.detail?.pxAt16 ?? '-'}`);
  assert.deepEqual(sizes, ['12:0.75rem:custom-property:12', '21:3rem:custom-property:48', '27:14px:font-shorthand:-', '33:1.25rem:declaration:20', '5:12px:declaration:-']);
  assert.deepEqual(findingsWhere(findings, 'font-size', 'styles/tokens.css').find((finding) => finding.line === 33)?.detail?.media, '@media (min-width: 640px)');
  const kindsOnShorthandLine = findings.filter((finding) => finding.file === 'styles/tokens.css' && finding.line === 27).map((finding) => `${finding.kind}=${finding.normalized}`);
  assert.deepEqual(kindsOnShorthandLine, ['font-family=lumen mono, monospace', 'font-size=14px', 'font-weight=600', 'line-height=1.5']);

  assert.deepEqual(findingsWhere(findings, 'contrast-pair', 'styles/tokens.css').map((finding) => [finding.normalized, finding.detail?.ratio]), [['#e8e8f0 on #0a0a12', 16.18], ['#00000099 on #ffffff', 5.74]]);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'css-token' && /^[$@]|--primary/.test(String(finding.detail?.property))).map((finding) => `${finding.normalized}=${finding.detail?.valueKind}`), [
    '@brand: #c084fc=color', '$panel-gap: 8px=other', '--primary: 222.2 47.4% 11.2%=color-channels',
  ]);
  assert.deepEqual(findingsWhere(findings, 'color', 'styles/legacy.less').map((finding) => finding.column), [9]);
  assert.ok(findingsWhere(findings, 'color-expression', 'styles/tokens.css').some((finding) => finding.normalized === 'hsl(var(--primary))'));
  assert.ok(findingsWhere(findings, 'asset-reference', 'styles/tokens.css').some((finding) => finding.normalized === 'https://fonts.example.com/css2' && finding.detail?.slot === 'css:import'));
  assert.deepEqual(findingsWhere(findings, 'radius', 'styles/tokens.css').map((finding) => finding.normalized), ['4px', '--radius-sm']);
  assert.deepEqual(findingsWhere(findings, 'motion', 'styles/tokens.css').map((finding) => finding.detail?.property), ['--duration-quick', 'keyframes', 'animation', 'reduced-motion', 'animation']);
  assert.deepEqual(findingsWhere(findings, 'image-asset', 'assets/logo.png').map((finding) => [finding.detail?.width, finding.detail?.height, finding.detail?.role, finding.target]), [[3, 2, 'logo', 'logo.variants']]);
  assert.equal(findingsWhere(findings, 'font-file', 'fonts/lumen-400.woff2')[0]?.detail?.sha1, '592dd5baf75f77542a4d6d204632621e389d4977');
  assert.deepEqual(findingsWhere(findings, 'codeowners', '.github/CODEOWNERS').map((finding) => finding.normalized), ['/styles/', '*.png']);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'skipped').map((finding) => `${finding.file}:${finding.normalized.split(':')[0]}`), ['notes.txt:no-parser', 'styles/broken.css:parse-error']);
  assert.ok(findings.some((finding) => finding.kind === 'license-file' && finding.file === 'LICENSE'));
  assert.ok(findings.some((finding) => finding.kind === 'locale-file' && finding.file === 'locales/en.json'));

  const summary = JSON.parse(await runCensusCli('--summary'));
  const accentGroup = summary.byKind.color.find((group: { normalized: string }) => group.normalized === '#c084fc');
  assert.deepEqual(accentGroup, { normalized: '#c084fc', count: 4, files: ['styles/legacy.less', 'styles/panel.scss', 'styles/tokens.css'] });
});
