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
  assert.deepEqual(kindsOnShorthandLine, ['font-weight=600', 'font-size=14px', 'line-height=1.5', 'font-family=lumen mono, monospace']);

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

test('the census lists copy slots, product names, brand docs, UI text, markup and script typography, SVG and data-file surfaces', async () => {
  const findings: Finding[] = (await runCensusCli()).trim().split('\n').map((line) => JSON.parse(line));
  const describe = (finding: Finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.normalized}`;

  assert.deepEqual(findings.filter((finding) => finding.kind === 'copy-slot').map((finding) => `${finding.detail?.slot}=${finding.raw}>${finding.target}`), [
    'readme:h1=Lumen Relay>naming.productName', 'readme:bold=Calm light for busy rooms.>naming.tagline',
    'readme:paragraph=Lumen Relay routes light signals between rooms \u2014 quietly. See the guide.>naming.descriptions', 'alt=Lumen Relay mark>voice.vocabulary',
    'alt=Beam>voice.vocabulary', 'frontmatter:title=Voice and tone>naming.descriptions', 'package:name=@lumen/lumen-relay>naming.productName',
    'package:description=Routes light signals between rooms.>naming.descriptions', 'package:keywords=light>naming.glossary', 'package:keywords=relay>naming.glossary',
    'manifest:name=Lumen Relay>naming.productName', 'manifest:short_name=Lumen>naming.productName', 'alt=Relay beam>voice.vocabulary', 'alt=Close mark>voice.vocabulary',
    'html:title=Lumen Relay>naming.descriptions', 'meta:description=Calm light for busy rooms.>naming.descriptions', 'html:h1=Meet Lumen Relay>naming.tagline',
  ]);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'product-name').map(describe), [
    'README.md:1:3 lumenrelay', 'README.md:5:1 lumenrelay', 'docs/RELEASE.md:3:1 lumenrelay', 'site/canvas.js:5:38 lumenrelay',
    'site/components/Hero.tsx:10:57 lumenrelay', 'site/components/Hero.tsx:16:25 lumenrelay', 'site/components/Hero.tsx:17:25 lumenrelay', 'site/index.html:4:10 lumenrelay', 'site/index.html:10:58 lumenrelay',
  ]);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'typographic-char').map(describe), ['README.md:5:48 em-dash', 'docs/NOTES.md:4:13 em-dash', 'docs/NOTES.md:4:31 em-dash', 'docs/NOTES.md:5:23 em-dash', 'docs/NOTES.md:6:15 em-dash', 'docs/NOTES.md:13:9 em-dash', 'docs/NOTES.md:18:20 em-dash', 'docs/NOTES.md:21:21 em-dash', 'docs/NOTES.md:23:20 em-dash', 'docs/RELEASE.md:3:19 em-dash', 'docs/VOICE.md:7:17 ellipsis', 'site/components/Badge.vue:2:43 em-dash',
    'site/components/Hero.tsx:11:78 em-dash', 'site/components/Hero.tsx:16:53 ellipsis', 'site/components/Hero.tsx:17:45 em-dash', 'site/components/Signed.js:2:33 copyright',
  ]);
  assert.deepEqual(findings.filter((finding) => finding.kind.startsWith('brand-doc')).map((finding) => `${finding.kind}:${finding.raw}:${finding.detail?.lineStart ?? finding.detail?.signal}-${finding.detail?.lineEnd ?? ''}`), [
    'brand-doc:docs/VOICE.md:name:voice-', 'brand-doc-section:Voice:5-13', 'brand-doc-section:Tone:9-12', 'brand-doc-section:relay.ts:13-13',
  ]);
  assert.ok(!findings.some((finding) => finding.kind === 'ui-text' && finding.raw.includes('--start')));
  assert.deepEqual(findings.filter((finding) => finding.kind === 'ui-text' && /Jerry|ships|Escaped/.test(finding.raw)).map((finding) => finding.raw), ['Lumen Relay ships \u2014 today', 'Escaped &mdash; stays literal.', 'Tom & Jerry \u2014 go']);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'font-size' && !finding.file.startsWith('styles/')).map((finding) => `${describe(finding)} ${finding.detail?.source}`), [
    'site/canvas.js:2:22 12px canvas', 'site/canvas.js:5:29 text-sm tailwind', 'site/canvas.js:6:27 text-xs tailwind',
    'site/components/Badge.vue:2:16 text-tiny tailwind', 'site/components/Badge.vue:7:16 10px css',
    'site/components/Hero.tsx:4:14 22px css', 'site/components/Hero.tsx:10:25 text-2xl tailwind', 'site/components/Hero.tsx:11:30 30 js-style', 'site/components/Hero.tsx:18:77 text-lg tailwind', 'site/components/Hero.tsx:20:48 15px style-attribute', 'site/index.html:7:29 18px css', 'site/index.html:10:14 text-4xl tailwind', 'site/index.html:10:23 text-huge tailwind',
    'site/index.html:11:54 13px style-attribute', 'site/index.html:12:133 11 svg-attribute', 'site/theme.yaml:2:13 28px data-file',
  ]);
  const markPaths = findings.filter((finding) => finding.kind === 'svg-path');
  assert.deepEqual(markPaths.map((finding) => finding.file), ['assets/mark.svg', 'site/index.html']);
  assert.equal(new Set(markPaths.map((finding) => finding.normalized)).size, 1);
  assert.deepEqual(findingsWhere(findings, 'image-asset', 'assets/mark.svg').map((finding) => [finding.detail?.width, finding.detail?.height]), [[32, 16]]);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'asset-reference' && !finding.file.startsWith('styles/')).map((finding) => `${finding.file} ${finding.normalized} ${finding.detail?.slot}`), [
    'README.md assets/logo.png md:image', 'docs/NOTES.md img/beam.png md:image', 'site.webmanifest /assets/logo.png manifest:icons', 'site/components/Hero.tsx /assets/beam.png img:src', 'site/components/Hero.tsx /assets/close.svg img:src', 'site/index.html /assets/og.png og:image',
  ]);
  assert.deepEqual(findingsWhere(findings, 'color', 'site/canvas.js').map(describe), ['site/canvas.js:3:22 #ff6600', 'site/canvas.js:4:46 #40b1b7']);
  assert.deepEqual(findingsWhere(findings, 'font-family', 'site/canvas.js').map(describe), ['site/canvas.js:2:27 inter']);
  assert.deepEqual(findings.filter((finding) => finding.file === 'site/answer.js'), []);
  const sourcePositionOf = (finding: Finding) => `${finding.kind} ${finding.file}:${finding.line}:${finding.column} ${finding.raw}`;
  assert.deepEqual(findings.filter((finding) => finding.file === 'docs/NOTES.md' && finding.kind !== 'ui-text').map(sourcePositionOf), [
    'typographic-char docs/NOTES.md:4:13 \u2014', 'typographic-char docs/NOTES.md:4:31 \u2014', 'typographic-char docs/NOTES.md:5:23 \u2014',
    'typographic-char docs/NOTES.md:6:15 \u2014', 'copy-slot docs/NOTES.md:8:3 Beam', 'asset-reference docs/NOTES.md:8:9 img/beam.png', 'typographic-char docs/NOTES.md:13:9 \u2014',
    'typographic-char docs/NOTES.md:18:20 \u2014', 'typographic-char docs/NOTES.md:21:21 \u2014', 'typographic-char docs/NOTES.md:23:20 \u2014',
  ]);
  assert.deepEqual(findings.filter((finding) => finding.file === 'styles/shorthand.css' && finding.kind !== 'font-face').map(sourcePositionOf), [
    'font-weight styles/shorthand.css:1:16 700', 'font-size styles/shorthand.css:1:20 42px', 'line-height styles/shorthand.css:1:27 1',
    'font-family styles/shorthand.css:1:29 "Segoe UI", sans-serif', 'asset-reference styles/shorthand.css:4:13 ../fonts/beam.woff2',
    'font-weight styles/shorthand.css:6:15 600', 'font-size styles/shorthand.css:6:38 18px', 'line-height styles/shorthand.css:6:43 1.2', 'font-family styles/shorthand.css:6:47 Inter',
    'font-weight styles/shorthand.css:7:16 bold', 'font-size styles/shorthand.css:7:21 16px', 'font-family styles/shorthand.css:7:34 Inter',
  ]);
  assert.deepEqual(findingsWhere(findings, 'radius', 'site/components/Hero.tsx').map(describe), ['site/components/Hero.tsx:19:75 6px']);
  assert.deepEqual(findings.filter((finding) => finding.kind === 'ui-text' && /Close dialog|Shuts|No sessions|Made with care/.test(finding.raw)).map(describe), [
    'site/components/Empty.jsx:1:31 no sessions yet', 'site/components/Hero.tsx:18:51 close dialog', 'site/components/Hero.tsx:18:114 shuts the panel', 'site/components/Signed.js:1:32 made with care',
  ]);
  assert.deepEqual(findingsWhere(findings, 'color', 'site.webmanifest').map((finding) => finding.normalized), ['#0a0a12']);

  const renamedFindings: Finding[] = (await runCensusCli('--name', 'Beacon')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(renamedFindings.filter((finding) => finding.kind === 'product-name' && finding.normalized === 'beacon').map(describe), ['docs/VOICE.md:11:19 beacon']);

  const vocabulary = JSON.parse(await runCensusCli('--summary')).vocabulary;
  assert.ok(vocabulary.phrases.some((entry: { term: string; count: number }) => entry.term === 'lumen relay' && entry.count >= 4));
});
