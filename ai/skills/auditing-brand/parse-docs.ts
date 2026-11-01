import path from 'node:path';
import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node as YamlNode } from 'yaml';
import { normalizeColor } from './color.ts';
import { addFinding, addProseFindings, advanceLocation, createSourceText, locatorFrom, addWholeFileFinding, collapseWhitespace, isTokenProperty, kebabCase } from './findings.ts';
import type { FindingCollector, ScanContext, SourceLocation } from './findings.ts';
import { addDeclarationFindings } from './parse-css.ts';
import { decodeCharacterReferences, scanMarkup } from './parse-markup.ts';

type Heading = { text: string; depth: number; line: number };

type MarkdownState = { isReadme: boolean; headings: Heading[]; hasReadmeH1: boolean; hasReadmeBold: boolean; hasReadmeParagraph: boolean };

const BRAND_DOC_NAME_PATTERN = /(?:^|[-_.\s])(product|design|brand|branding|style|styleguide|voice|tone|mission|vision|values|personality|audience|anti-?references?|identity|messaging|positioning)(?:$|[-_.\s])/i;
const BRAND_DOC_HEADING_PATTERN = /\b(voice|tone|mission|vision|values|personality|audiences?|anti-?references?|brand|positioning|tagline|brand personality)\b/i;
const DATA_STYLE_PROPERTY_PATTERN = /^(?:font(?:-size|-family|-weight|-feature-settings|-variant-ligatures)?|letter-spacing|line-height|text-transform|border(?:-[a-z]+)*-radius|box-shadow|text-shadow|(?:transition|animation)(?:-[a-z-]+)?|color|fill|stroke|background|[a-z-]+-color)$/;
const DATA_FILE_HINT_PATTERN = /font|colou?r|radius|shadow|#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i;
const PACKAGE_COPY_KEYS = new Set(['name', 'description', 'keywords', 'homepage']);
const MANIFEST_COPY_KEYS = new Set(['name', 'short_name', 'description']);
const MARKDOWN_ESCAPE_PATTERN = /\\[!-\/:-@[-`{-~]/g;
const CODE_SPAN_OR_URL_PATTERN = /`[^`\n]*`|\]\([^)\s]*(?:\s+"[^"]*")?\)|<https?:[^>\s]*>|https?:\/\/\S+/g;

function blankMatches(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/g, ' '));
}

function inlinePlainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens.map((token) => {
    if (token.type === 'codespan' || token.type === 'html' || token.type === 'image') return ' ';
    if (token.type === 'br') return ' ';
    if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) return inlinePlainText(token.tokens as Token[]);
    if (token.type === 'text') return decodeCharacterReferences(token.text).text;
    return 'text' in token && typeof token.text === 'string' ? token.text : '';
  }).join('');
}

function inlineImagesAndLinks(tokens: Token[] | undefined): Array<Tokens.Image | Tokens.Link> {
  if (!tokens) return [];
  return tokens.flatMap((token) => {
    const nested = 'tokens' in token && Array.isArray(token.tokens) ? inlineImagesAndLinks(token.tokens as Token[]) : [];
    if (token.type === 'image' || token.type === 'link') return [token as Tokens.Image | Tokens.Link, ...nested];
    return nested;
  });
}

function isAssetPath(href: string): boolean {
  return /\.(?:svg|png|ico|jpe?g|gif|webp|avif|woff2?|ttf|otf|eot|css|webmanifest)$/i.test(href.split(/[?#]/)[0] ?? '');
}

function scalarOffset(collector: FindingCollector, node: YamlNode, baseOffset: number): number {
  const start = baseOffset + (node.range?.[0] ?? 0);
  const firstCharacter = collector.source.text[start];
  return firstCharacter === '"' || firstCharacter === "'" ? start + 1 : start;
}

function scanDataNode(collector: FindingCollector, node: unknown, keyPath: string[], baseOffset: number, slotPrefix: string | undefined): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      scanDataNode(collector, pair.value, [...keyPath, key], baseOffset, slotPrefix);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) scanDataNode(collector, item, keyPath, baseOffset, slotPrefix);
    return;
  }
  if (!isScalar(node) || (typeof node.value !== 'string' && typeof node.value !== 'number')) return;
  const value = String(node.value);
  const key = keyPath[keyPath.length - 1] ?? '';
  const location = collector.source.locationAt(scalarOffset(collector, node, baseOffset));
  const keyDetail = { key: keyPath.join('.') };
  if (slotPrefix && keyPath.length <= 2) addDataCopySlot(collector, slotPrefix, keyPath, value, location);
  if (slotPrefix === 'manifest' && keyPath[0] === 'icons' && key === 'src') {
    addFinding(collector, 'asset-reference', location, value, value.split(/[?#]/)[0] ?? value, { slot: 'manifest:icons' });
  }
  const property = isTokenProperty(key) ? key : kebabCase(key.replace(/_/g, '-'));
  if (DATA_STYLE_PROPERTY_PATTERN.test(property) || property.startsWith('--')) {
    addDeclarationFindings(collector, property, value, location, keyDetail, 'data-file');
    return;
  }
  if (typeof node.value === 'string' && normalizeColor(value)) addDeclarationFindings(collector, 'color', value, location, keyDetail, 'data-file');
}

function addDataCopySlot(collector: FindingCollector, slotPrefix: string, keyPath: string[], value: string, location: SourceLocation): void {
  const topKey = keyPath[0] ?? '';
  const copyKeys = slotPrefix === 'package' ? PACKAGE_COPY_KEYS : slotPrefix === 'manifest' ? MANIFEST_COPY_KEYS : new Set(['title', 'description', 'tagline', 'name']);
  if (!copyKeys.has(topKey) || (keyPath.length === 2 && topKey !== 'keywords')) return;
  const collapsed = collapseWhitespace(value);
  if (collapsed) addFinding(collector, 'copy-slot', location, collapsed, collapsed.toLowerCase(), { slot: `${slotPrefix}:${topKey}` });
}

function dataSlotPrefix(file: string): string | undefined {
  const baseName = path.posix.basename(file).toLowerCase();
  if (baseName === 'package.json') return 'package';
  if (baseName.endsWith('.webmanifest') || baseName === 'manifest.json') return 'manifest';
  return undefined;
}

function parseYaml(text: string): unknown {
  const document = parseDocument(text, { keepSourceTokens: false, uniqueKeys: false });
  const firstError = document.errors[0];
  if (firstError) throw new Error(firstError.message);
  return document.contents;
}

export function scanDataFile(collector: FindingCollector, text: string): void {
  const slotPrefix = dataSlotPrefix(collector.file);
  if (!slotPrefix && !DATA_FILE_HINT_PATTERN.test(text)) return;
  scanDataNode(collector, parseYaml(text), [], 0, slotPrefix);
}

function headingLineEnd(headings: Heading[], index: number, lastLine: number): number {
  const heading = headings[index];
  const nextHeading = headings.slice(index + 1).find((later) => later.depth <= (heading?.depth ?? 0));
  return nextHeading ? nextHeading.line - 1 : lastLine;
}

function brandDocSignal(file: string, headings: Heading[]): string | undefined {
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const nameMatch = BRAND_DOC_NAME_PATTERN.exec(stem);
  if (nameMatch?.[1]) return `name:${nameMatch[1].toLowerCase()}`;
  const heading = headings.find((candidate) => candidate.depth <= 2 && BRAND_DOC_HEADING_PATTERN.test(candidate.text));
  return heading ? `heading:${collapseWhitespace(heading.text).toLowerCase()}` : undefined;
}

function addMarkdownBlock(collector: FindingCollector, token: Token, offset: number, context: ScanContext, state: MarkdownState): void {
  const location = collector.source.locationAt(offset);
  const inlineTokens = 'tokens' in token ? (token.tokens as Token[] | undefined) : undefined;
  const plainText = collapseWhitespace(inlinePlainText(inlineTokens));
  const slot = token.type === 'heading' ? `md:h${(token as Tokens.Heading).depth}` : 'md:p';
  if (token.type === 'heading') state.headings.push({ text: plainText, depth: (token as Tokens.Heading).depth, line: location.line });
  let referenceCursor = 0;
  for (const reference of inlineImagesAndLinks(inlineTokens)) {
    const referenceIndex = token.raw.indexOf(reference.raw, referenceCursor);
    referenceCursor = referenceIndex === -1 ? referenceCursor : referenceIndex;
    const referenceLocation = referenceIndex === -1 ? location : advanceLocation(location, token.raw.slice(0, referenceIndex));
    if (reference.type === 'image' && reference.text.trim()) addFinding(collector, 'copy-slot', referenceLocation, reference.text, collapseWhitespace(reference.text).toLowerCase(), { slot: 'alt' });
    if (isAssetPath(reference.href)) addFinding(collector, 'asset-reference', referenceLocation, reference.href, reference.href.split(/[?#]/)[0] ?? reference.href, { slot: `md:${reference.type}` });
  }
  if (state.isReadme) addReadmeSlots(collector, token, plainText, location, state);
  if (!/\p{L}/u.test(plainText)) return;
  addFinding(collector, 'ui-text', location, plainText, plainText.toLowerCase(), { slot });
  const decodedProse = decodeCharacterReferences(blankMatches(blankMatches(token.raw, CODE_SPAN_OR_URL_PATTERN), MARKDOWN_ESCAPE_PATTERN));
  const rawLocator = locatorFrom(location, token.raw);
  addProseFindings(collector, decodedProse.text, (decodedIndex) => rawLocator(decodedProse.rawIndexOf(decodedIndex)), context, { slot });
}

function addReadmeSlots(collector: FindingCollector, token: Token, plainText: string, location: SourceLocation, state: MarkdownState): void {
  if (!plainText) return;
  if (token.type === 'heading' && (token as Tokens.Heading).depth === 1 && !state.hasReadmeH1) {
    state.hasReadmeH1 = true;
    addFinding(collector, 'copy-slot', location, plainText, plainText.toLowerCase(), { slot: 'readme:h1' });
    return;
  }
  if (token.type !== 'paragraph') return;
  const inlineTokens = (token as Tokens.Paragraph).tokens.filter((inline) => inline.type !== 'space' && !(inline.type === 'text' && !inline.raw.trim()));
  const isBoldLine = inlineTokens.length === 1 && inlineTokens[0]?.type === 'strong';
  if (isBoldLine && !state.hasReadmeBold) {
    state.hasReadmeBold = true;
    addFinding(collector, 'copy-slot', location, plainText, plainText.toLowerCase(), { slot: 'readme:bold' });
    return;
  }
  if (isBoldLine || state.hasReadmeParagraph || !/\p{L}{3}/u.test(plainText)) return;
  state.hasReadmeParagraph = true;
  addFinding(collector, 'copy-slot', location, plainText, plainText.toLowerCase(), { slot: 'readme:paragraph' });
}

function walkMarkdownTokens(collector: FindingCollector, tokens: Token[], parentRaw: string, parentOffset: number, context: ScanContext, state: MarkdownState): void {
  let cursor = 0;
  for (const token of tokens) {
    const foundIndex = parentRaw.indexOf(token.raw, cursor);
    const index = foundIndex === -1 ? cursor : foundIndex;
    cursor = index + (foundIndex === -1 ? 0 : token.raw.length);
    const offset = parentOffset + index;
    if (token.type === 'heading' || token.type === 'paragraph' || token.type === 'text') {
      addMarkdownBlock(collector, token, offset, context, state);
      continue;
    }
    if (token.type === 'html') {
      scanMarkup(collector, token.raw, context, offset);
      continue;
    }
    if (token.type === 'list') {
      walkMarkdownTokens(collector, (token as Tokens.List).items, token.raw, offset, context, state);
      continue;
    }
    if (token.type === 'list_item' || token.type === 'blockquote') {
      walkMarkdownTokens(collector, (token as Tokens.ListItem | Tokens.Blockquote).tokens, token.raw, offset, context, state);
      continue;
    }
    if (token.type === 'table') addTableText(collector, token as Tokens.Table, offset);
  }
}

function addTableText(collector: FindingCollector, table: Tokens.Table, offset: number): void {
  const location = collector.source.locationAt(offset);
  for (const cell of [...table.header, ...table.rows.flat()]) {
    const plainText = collapseWhitespace(inlinePlainText(cell.tokens));
    if (/\p{L}/u.test(plainText)) addFinding(collector, 'ui-text', location, plainText, plainText.toLowerCase(), { slot: 'md:table' });
  }
}

function frontMatterLength(text: string): number {
  if (!/^---\r?\n/.test(text)) return 0;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
  return closing ? 3 + closing.index + closing[0].length : 0;
}

function scanFrontMatter(collector: FindingCollector, text: string, length: number): void {
  const bodyStart = text.indexOf('\n') + 1;
  const yamlText = text.slice(bodyStart, length).replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '\n');
  try {
    scanDataNode(collector, parseYaml(yamlText), [], bodyStart, 'frontmatter');
  } catch (parseError) {
    addFinding(collector, 'skipped', { line: 1, column: 1 }, '---', 'front-matter-parse-error', { reason: `front-matter-parse-error: ${(parseError as Error).message.split('\n')[0]}` });
  }
}

export function scanMarkdown(originalCollector: FindingCollector, originalText: string, context: ScanContext): void {
  const text = originalText.replace(/\r\n?/g, '\n');
  const collector = text === originalText ? originalCollector : { ...originalCollector, source: createSourceText(text) };
  const state: MarkdownState = { isReadme: /^readme(?:\.|$)/i.test(path.posix.basename(collector.file)), headings: [], hasReadmeH1: false, hasReadmeBold: false, hasReadmeParagraph: false };
  const frontLength = frontMatterLength(text);
  if (frontLength > 0) scanFrontMatter(collector, text, frontLength);
  const body = text.slice(frontLength);
  walkMarkdownTokens(collector, Lexer.lex(body, { gfm: true }), body, frontLength, context, state);
  const signal = brandDocSignal(collector.file, state.headings);
  if (!signal) return;
  addWholeFileFinding(collector, 'brand-doc', collector.file, collector.file.toLowerCase(), { signal });
  const lastLine = collector.source.locationAt(text.trimEnd().length).line;
  state.headings.forEach((heading, index) => {
    addFinding(collector, 'brand-doc-section', { line: heading.line, column: 1 }, heading.text, heading.text.toLowerCase(), {
      depth: heading.depth, lineStart: heading.line, lineEnd: headingLineEnd(state.headings, index, lastLine),
    });
  });
}

export function firstMarkdownHeading(text: string): string | undefined {
  const body = text.slice(frontMatterLength(text));
  const heading = Lexer.lex(body, { gfm: true }).find((token): token is Tokens.Heading => token.type === 'heading' && token.depth === 1);
  return heading ? collapseWhitespace(inlinePlainText(heading.tokens)) : undefined;
}
