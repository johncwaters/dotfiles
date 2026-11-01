import { Parser } from 'htmlparser2';
import { normalizeColor } from './color.ts';
import { addFinding, addTailwindClassFindings, addUiText, collapseWhitespace, isFontFile, isImageFile } from './findings.ts';
import type { FindingCollector, IndexLocator, ScanContext, SourceLocation } from './findings.ts';
import { addDeclarationFindings, scanCss } from './parse-css.ts';
import type { FindingDetail } from './bible/targets.ts';

type PendingText = { text: string; offset: number };

type DecodedPiece = { decodedStart: number; rawStart: number; isReference: boolean };

export type DecodedText = { text: string; rawIndexOf: (decodedIndex: number) => number };

type OpenElement = { name: string; attributes: Record<string, string>; isInsideSvg: boolean; copySlot?: string; copyTexts: PendingText[] };

const SKIPPED_TEXT_ELEMENTS = new Set(['script', 'style', 'code', 'pre', 'noscript']);
export const UI_TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt']);
const ASSET_ATTRIBUTES = new Set(['src', 'href', 'srcset', 'poster', 'data', 'xlink:href']);
const ASSET_EXTENSIONS = new Set(['.css', '.webmanifest', '.svg', '.ico']);
const SVG_ICON_ATTRIBUTES = ['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
const SVG_PRESENTATION_ATTRIBUTES = new Set([
  'fill', 'stroke', 'stop-color', 'flood-color', 'color', 'font-size', 'font-family', 'font-weight', 'letter-spacing', 'text-transform',
]);
const META_COPY_NAMES = new Set(['description', 'application-name', 'theme-color', 'apple-mobile-web-app-title']);
const MIN_SVG_PATH_LENGTH = 25;
const LINK_LIKE_META_SLOT = /:(?:image|url|card|site|creator)(?::|$)/;

const CHARACTER_REFERENCE_PATTERN = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const decodedReferenceCache = new Map<string, string>();

function decodeReference(reference: string): string {
  const cached = decodedReferenceCache.get(reference);
  if (cached !== undefined) return cached;
  let decoded = '';
  const referenceParser = new Parser({ ontext(text) { decoded += text; } }, { decodeEntities: true });
  referenceParser.write(reference);
  referenceParser.end();
  decodedReferenceCache.set(reference, decoded);
  return decoded;
}

export function decodeCharacterReferences(raw: string): DecodedText {
  if (!raw.includes('&')) return { text: raw, rawIndexOf: (decodedIndex) => decodedIndex };
  const pieces: DecodedPiece[] = [];
  let text = '';
  let rawCursor = 0;
  for (const match of raw.matchAll(CHARACTER_REFERENCE_PATTERN)) {
    pieces.push({ decodedStart: text.length, rawStart: rawCursor, isReference: false });
    text += raw.slice(rawCursor, match.index);
    pieces.push({ decodedStart: text.length, rawStart: match.index, isReference: true });
    text += decodeReference(match[0]);
    rawCursor = match.index + match[0].length;
  }
  pieces.push({ decodedStart: text.length, rawStart: rawCursor, isReference: false });
  text += raw.slice(rawCursor);
  const rawIndexOf = (decodedIndex: number): number => {
    const piece = pieces.findLast((candidate) => candidate.decodedStart <= decodedIndex) ?? pieces[0];
    if (!piece) return decodedIndex;
    return piece.isReference ? piece.rawStart : piece.rawStart + decodedIndex - piece.decodedStart;
  };
  return { text, rawIndexOf };
}

function assetPathOf(url: string): string | undefined {
  const withoutQuery = url.trim().split(/[?#]/)[0] ?? '';
  const extension = /\.[a-z0-9]+$/i.exec(withoutQuery)?.[0]?.toLowerCase() ?? '';
  if (isImageFile(extension) || isFontFile(extension) || ASSET_EXTENSIONS.has(extension)) return withoutQuery;
  return undefined;
}

function metaCopySlot(attributes: Record<string, string>): string | undefined {
  const name = (attributes.name ?? attributes.property ?? '').toLowerCase();
  if (META_COPY_NAMES.has(name)) return `meta:${name}`;
  if (/^(?:og|twitter):[\w:-]+$/.test(name)) return name;
  return undefined;
}

function blankExpressions(text: string): string {
  return text.replace(/\{[^{}]*\}/g, (expression) => expression.replace(/[^\n]/g, ' '));
}

function blankAstroFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const closingIndex = text.indexOf('\n---', 3);
  if (closingIndex === -1) return text;
  return text.slice(0, closingIndex + 4).replace(/[^\n]/g, ' ') + text.slice(closingIndex + 4);
}

export function addAssetReferenceFindings(collector: FindingCollector, elementName: string, attributeName: string, value: string, location: SourceLocation): void {
  if (!ASSET_ATTRIBUTES.has(attributeName)) return;
  const urls = attributeName === 'srcset' ? value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '') : [value];
  for (const url of urls) {
    const assetPath = assetPathOf(url);
    if (assetPath) addFinding(collector, 'asset-reference', location, url.trim(), assetPath, { slot: `${elementName}:${attributeName}` });
  }
}

export function scanMarkup(collector: FindingCollector, markup: string, context: ScanContext, baseOffset = 0): void {
  const locationAt = (localOffset: number): SourceLocation => collector.source.locationAt(baseOffset + localOffset);
  const openElements: OpenElement[] = [];
  const attributeValueOffsets = new Map<string, number>();
  let pendingTexts: PendingText[] = [];

  const currentElement = (): OpenElement | undefined => openElements[openElements.length - 1];

  const decodedAt = (raw: string, offset: number): DecodedText & { locate: IndexLocator } => {
    const decoded = decodeCharacterReferences(raw);
    return { ...decoded, locate: (decodedIndex) => locationAt(offset + decoded.rawIndexOf(decodedIndex)) };
  };

  const addCopySlot = (slot: string, value: string, location: SourceLocation): void => {
    const collapsed = collapseWhitespace(value);
    if (!collapsed) return;
    const normalized = slot === 'meta:theme-color' ? (normalizeColor(collapsed) ?? collapsed.toLowerCase()) : collapsed.toLowerCase();
    addFinding(collector, 'copy-slot', location, collapsed, normalized, { slot });
  };

  const scanStyleText = (cssText: string, offset: number, syntax: 'css' | 'scss', source: 'css' | 'style-attribute'): void => {
    const start = locationAt(offset);
    try {
      const { tailwindTextNames } = scanCss(collector, cssText, { syntax, startLine: start.line, startColumn: start.column, source });
      for (const name of tailwindTextNames) context.tailwindTextNames.add(name);
    } catch (parseError) {
      addFinding(collector, 'skipped', start, cssText.slice(0, 80), 'style-parse-error', { reason: `style-parse-error: ${(parseError as Error).message.split('\n')[0]}` });
    }
  };

  const flushText = (): void => {
    if (pendingTexts.length === 0) return;
    const texts = pendingTexts;
    pendingTexts = [];
    const element = currentElement();
    const joinedText = texts.map((pending) => pending.text).join('');
    const offset = texts[0]?.offset ?? 0;
    if (element?.name === 'style') {
      scanStyleText(joinedText, offset, /scss|sass|less/i.test(element.attributes.lang ?? '') ? 'scss' : 'css', 'css');
      return;
    }
    if (openElements.some((open) => SKIPPED_TEXT_ELEMENTS.has(open.name))) return;
    const decoded = decodedAt(joinedText, offset);
    const visibleText = blankExpressions(decoded.text);
    const slot = element?.name ?? 'text';
    const firstVisibleIndex = /^\s*/.exec(visibleText)?.[0].length ?? 0;
    for (const open of openElements) {
      if (open.copySlot) open.copyTexts.push({ text: visibleText, offset: offset + decoded.rawIndexOf(firstVisibleIndex) });
    }
    addUiText(collector, visibleText, decoded.locate, context, { slot });
  };

  const addCollectedCopySlot = (element: OpenElement): void => {
    const firstText = element.copyTexts.find((pending) => pending.text.trim());
    if (!element.copySlot || !firstText) return;
    addCopySlot(element.copySlot, element.copyTexts.map((pending) => pending.text).join(''), locationAt(firstText.offset));
  };

  const addAttributeFindings = (element: OpenElement): void => {
    for (const [name, rawValue] of Object.entries(element.attributes)) {
      const offset = attributeValueOffsets.get(name);
      if (offset === undefined || !rawValue.trim()) continue;
      const location = locationAt(offset);
      const decoded = decodedAt(rawValue, offset);
      const value = decoded.text;
      const scopeDetail: FindingDetail = { element: element.name };
      if (name === 'style' && !rawValue.includes('{')) scanStyleText(rawValue, offset, 'css', 'style-attribute');
      if (name === 'class' || name === 'className') addTailwindClassFindings(collector, rawValue, location, context, { slot: `${element.name}:class` });
      if (UI_TEXT_ATTRIBUTES.has(name)) addUiText(collector, value, decoded.locate, context, { slot: `${element.name}:${name}` });
      if (name === 'alt') addCopySlot('alt', value, location);
      if (element.isInsideSvg && SVG_PRESENTATION_ATTRIBUTES.has(name)) addDeclarationFindings(collector, name, rawValue, location, scopeDetail, 'svg-attribute');
      if (element.name === 'path' && name === 'd' && rawValue.length >= MIN_SVG_PATH_LENGTH) {
        addFinding(collector, 'svg-path', location, rawValue.slice(0, 120), collapseWhitespace(rawValue.replace(/,/g, ' ')), { length: rawValue.length });
      }
      addAssetReferenceFindings(collector, element.name, name, value, location);
    }
    if (element.name === 'meta') addMetaFindings(element);
    if (element.name === 'svg') addSvgIcon(element);
  };

  const addMetaFindings = (element: OpenElement): void => {
    const slot = metaCopySlot(element.attributes);
    const content = decodeCharacterReferences(element.attributes.content ?? '').text;
    const offset = attributeValueOffsets.get('content');
    if (!slot || offset === undefined) return;
    if (!LINK_LIKE_META_SLOT.test(slot)) addCopySlot(slot, content, locationAt(offset));
    const assetPath = /:image$/.test(slot) ? assetPathOf(content) : undefined;
    if (assetPath) addFinding(collector, 'asset-reference', locationAt(offset), content, assetPath, { slot });
  };

  const addSvgIcon = (element: OpenElement): void => {
    const detail: FindingDetail = {};
    for (const name of SVG_ICON_ATTRIBUTES) {
      const value = element.attributes[name];
      if (value !== undefined) detail[name] = collapseWhitespace(value);
    }
    const normalized = Object.entries(detail).map(([name, value]) => `${name}=${value}`).join(' ');
    addFinding(collector, 'svg-icon', locationAt(svgOpenOffset), normalized || 'svg', normalized || 'svg', detail);
  };

  let svgOpenOffset = 0;
  const parser = new Parser({
    onopentagname() {
      flushText();
      attributeValueOffsets.clear();
    },
    onattribute(name) {
      const attributeSource = markup.slice(parser.startIndex, parser.endIndex + 1);
      const equalsIndex = attributeSource.indexOf('=');
      if (equalsIndex === -1) return;
      const valueLead = /^\s*["']?/.exec(attributeSource.slice(equalsIndex + 1))?.[0] ?? '';
      attributeValueOffsets.set(name, parser.startIndex + equalsIndex + 1 + valueLead.length);
    },
    onopentag(name, attributes) {
      const parent = currentElement();
      const isInsideSvg = name === 'svg' || (parent?.isInsideSvg ?? false);
      const copySlot = name === 'h1' || (name === 'title' && !isInsideSvg) ? `html:${name}` : undefined;
      const element: OpenElement = { name, attributes, isInsideSvg, copyTexts: [], ...(copySlot ? { copySlot } : {}) };
      if (name === 'svg') svgOpenOffset = parser.startIndex;
      openElements.push(element);
      addAttributeFindings(element);
    },
    ontext(text) {
      pendingTexts.push({ text, offset: parser.startIndex });
    },
    onclosetag(name) {
      flushText();
      const openIndex = openElements.map((open) => open.name).lastIndexOf(name);
      if (openIndex === -1) return;
      for (const closed of openElements.slice(openIndex)) addCollectedCopySlot(closed);
      openElements.length = openIndex;
    },
  }, { recognizeSelfClosing: true, lowerCaseAttributeNames: false, decodeEntities: false });
  parser.write(markup);
  parser.end();
  flushText();
}

export function scanMarkupFile(collector: FindingCollector, text: string, context: ScanContext): void {
  const isAstro = collector.file.toLowerCase().endsWith('.astro');
  scanMarkup(collector, isAstro ? blankAstroFrontmatter(text) : text, context);
}
