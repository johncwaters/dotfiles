import { normalizeColor } from './color.ts';
import type { FindingDetail, FindingKind, UntargetedFinding } from './bible/targets.ts';

export type SourceLocation = { line: number; column: number };

export type SourceText = { text: string; lineText: (line: number) => string; locationAt: (offset: number) => SourceLocation };

export type FindingCollector = { file: string; source: SourceText; findings: UntargetedFinding[] };

export type IndexLocator = (index: number) => SourceLocation;

export type DeferredTailwindText = { name: string; finding: UntargetedFinding };

export type ScanContext = { productNamePattern?: RegExp; tailwindTextNames: Set<string>; deferredTailwindText: DeferredTailwindText[] };

const MAX_CONTEXT_LENGTH = 200;

export function createSourceText(text: string): SourceText {
  let lineStarts: number[] | undefined;
  const ensureLineStarts = (): number[] => {
    if (lineStarts) return lineStarts;
    const starts = [0];
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
    lineStarts = starts;
    return starts;
  };
  const lineText = (line: number): string => {
    const starts = ensureLineStarts();
    const start = starts[line - 1];
    if (start === undefined) return '';
    const end = starts[line] ?? text.length + 1;
    return text.slice(start, end - 1);
  };
  const locationAt = (offset: number): SourceLocation => {
    const starts = ensureLineStarts();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= offset) low = middle;
      if ((starts[middle] ?? 0) > offset) high = middle - 1;
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
  };
  return { text, lineText, locationAt };
}

export function createCollector(file: string, text: string): FindingCollector {
  return { file, source: createSourceText(text), findings: [] };
}

export function addFinding(collector: FindingCollector, kind: FindingKind, location: SourceLocation, raw: string, normalized: string, detail?: FindingDetail): void {
  collector.findings.push(buildFinding(collector, kind, location, raw, normalized, detail));
}

function buildFinding(collector: FindingCollector, kind: FindingKind, location: SourceLocation, raw: string, normalized: string, detail?: FindingDetail): UntargetedFinding {
  const context = location.line > 0 ? collector.source.lineText(location.line).trim().slice(0, MAX_CONTEXT_LENGTH) : '';
  const finding: UntargetedFinding = { kind, file: collector.file, line: location.line, column: location.column, raw, normalized };
  if (context) finding.context = context;
  if (detail && Object.keys(detail).length > 0) finding.detail = detail;
  return finding;
}

export function addWholeFileFinding(collector: FindingCollector, kind: FindingKind, raw: string, normalized: string, detail?: FindingDetail): void {
  addFinding(collector, kind, { line: 0, column: 0 }, raw, normalized, detail);
}

export function advanceLocation(start: SourceLocation, precedingText: string): SourceLocation {
  const lastNewline = precedingText.lastIndexOf('\n');
  if (lastNewline === -1) return { line: start.line, column: start.column + precedingText.length };
  const newlineCount = precedingText.split('\n').length - 1;
  return { line: start.line + newlineCount, column: precedingText.length - lastNewline };
}

export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function isTokenProperty(property: string): boolean {
  return property.startsWith('--') || property.startsWith('$') || property.startsWith('@');
}

export function kebabCase(property: string): string {
  if (isTokenProperty(property)) return property;
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
}

export function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    const isSeparator = depth === 0 && !quote && (separator === ' ' ? /\s/.test(character) : character === separator);
    if (isSeparator) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function matchingParenthesisEnd(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return value.length - 1;
}

const COLOR_LITERAL_PATTERN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)/gi;
const COLOR_EXPRESSION_PATTERN = /\b(?:color-mix|(?:repeating-)?(?:linear|radial|conic)-gradient|lab|lch|hwb|color|(?:rgba?|hsla?|oklch|oklab)(?=\([^()]*var\())\(/gi;

export type ValueMatch = { raw: string; normalized: string; offset: number };

export function findColorLiterals(value: string): ValueMatch[] {
  const literals: ValueMatch[] = [];
  for (const match of value.matchAll(COLOR_LITERAL_PATTERN)) {
    const normalized = normalizeColor(match[0]);
    if (normalized) literals.push({ raw: match[0], normalized, offset: match.index });
  }
  return literals;
}

export function findColorExpressions(value: string): ValueMatch[] {
  const expressions: ValueMatch[] = [];
  for (const match of value.matchAll(COLOR_EXPRESSION_PATTERN)) {
    const end = matchingParenthesisEnd(value, match.index + match[0].length - 1);
    const raw = value.slice(match.index, end + 1);
    expressions.push({ raw, normalized: collapseWhitespace(raw).toLowerCase(), offset: match.index });
  }
  return expressions;
}

const SIZE_KEYWORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'smaller', 'larger']);
const LENGTH_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(px|rem|em|%|pt|pc|vw|vh|vmin|vmax|ch|ex|cap|lh|rlh|cqw|cqh|cqi|cqb)?$/i;
const SIZE_FUNCTION_PATTERN = /^(?:calc|clamp|min|max|var)\(.*\)$/is;

export function isSizeToken(token: string): boolean {
  const lowered = token.toLowerCase();
  if (SIZE_KEYWORDS.has(lowered)) return true;
  if (SIZE_FUNCTION_PATTERN.test(token)) return true;
  const lengthMatch = LENGTH_PATTERN.exec(token);
  return Boolean(lengthMatch && (lengthMatch[1] || Number(token) === 0));
}

export function normalizeLength(raw: string): { normalized: string; detail: FindingDetail } {
  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');
  const variableMatch = /^var\((--[\w-]+)(?:,.*)?\)$/.exec(compact);
  if (variableMatch?.[1]) return { normalized: variableMatch[1], detail: {} };
  const relativeMatch = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(rem|em)$/.exec(compact);
  if (relativeMatch?.[1]) return { normalized: compact, detail: { pxAt16: Number((Number(relativeMatch[1]) * 16).toFixed(3)) } };
  return { normalized: compact, detail: {} };
}

export function normalizeFontFamily(value: string): string {
  return splitTopLevel(value, ',').map((family) => family.replace(/^["']|["']$/g, '').trim().toLowerCase()).join(', ');
}

const WEIGHT_KEYWORDS = new Set(['bold', 'bolder', 'lighter']);

function isWeightToken(token: string): boolean {
  if (WEIGHT_KEYWORDS.has(token.toLowerCase())) return true;
  const weight = Number(token);
  return Number.isInteger(weight) && weight >= 1 && weight <= 1000;
}

export type ShorthandPart = { raw: string; offset: number };

export type FontShorthand = { size?: ShorthandPart; lineHeight?: ShorthandPart; weight?: ShorthandPart; family?: ShorthandPart };

function shorthandParts(value: string): ShorthandPart[] {
  const parts: ShorthandPart[] = [];
  let depth = 0;
  let quote = '';
  let partStart = -1;
  const closePart = (end: number): void => {
    if (partStart !== -1) parts.push({ raw: value.slice(partStart, end), offset: partStart });
    partStart = -1;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    const isTopLevel = depth === 0 && !quote;
    if (isTopLevel && /\s/.test(character)) {
      closePart(index);
      continue;
    }
    if (isTopLevel && character === '/') {
      closePart(index);
      parts.push({ raw: '/', offset: index });
      continue;
    }
    if (partStart === -1) partStart = index;
  }
  closePart(value.length);
  return parts;
}

export function parseFontShorthand(value: string): FontShorthand {
  const parts = shorthandParts(value);
  const sizeIndex = parts.findIndex((part) => isSizeToken(part.raw));
  const size = parts[sizeIndex];
  if (!size) return {};
  const shorthand: FontShorthand = { size };
  const weight = parts.slice(0, sizeIndex).find((part) => isWeightToken(part.raw));
  if (weight) shorthand.weight = weight;
  const hasLineHeight = parts[sizeIndex + 1]?.raw === '/' && parts[sizeIndex + 2] !== undefined;
  const lineHeight = hasLineHeight ? parts[sizeIndex + 2] : undefined;
  if (lineHeight) shorthand.lineHeight = lineHeight;
  const familyStart = parts[sizeIndex + (lineHeight ? 3 : 1)];
  if (familyStart) shorthand.family = { raw: value.slice(familyStart.offset).trimEnd(), offset: familyStart.offset };
  return shorthand;
}

const DURATION_PATTERN = /(?:^|[\s,(])(-?(?:\d+(?:\.\d*)?|\.\d+))(ms|s)\b/gi;

export function durationsInMs(value: string): number[] {
  return [...value.matchAll(DURATION_PATTERN)].map((match) => Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1));
}

type CustomPropertyRule = { pattern: RegExp; valueKind: string; findingKind?: FindingKind };

const CUSTOM_PROPERTY_RULES: CustomPropertyRule[] = [
  { pattern: /--line-height$|^--(?:leading|line-height)(?:-|$)/, valueKind: 'line-height', findingKind: 'line-height' },
  { pattern: /--letter-spacing$|^--(?:tracking|letter-spacing)(?:-|$)/, valueKind: 'letter-spacing', findingKind: 'letter-spacing' },
  { pattern: /--font-weight$|^--(?:font-weight|weight)(?:-|$)/, valueKind: 'font-weight', findingKind: 'font-weight' },
  { pattern: /^--(?:text|type|font-size|fs)-/, valueKind: 'font-size', findingKind: 'font-size' },
  { pattern: /^--(?:font|font-family|family)(?:-|$)/, valueKind: 'font-family', findingKind: 'font-family' },
  { pattern: /^--(?:radius|rounded|corner)(?:-|$)/, valueKind: 'radius', findingKind: 'radius' },
  { pattern: /^--(?:shadow|elevation|drop-shadow)(?:-|$)/, valueKind: 'shadow', findingKind: 'shadow' },
  { pattern: /^--(?:space|spacing|gap|gutter|size-space)(?:-|$)/, valueKind: 'spacing', findingKind: 'spacing' },
  { pattern: /^--(?:duration|ease|easing|motion|transition|animate|animation)(?:-|$)/, valueKind: 'motion', findingKind: 'motion' },
];

const COLOR_CHANNELS_PATTERN = /^\s*-?\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%\s*$/;

export function classifyCustomProperty(name: string, value: string): CustomPropertyRule | undefined {
  if (normalizeColor(value)) return { pattern: /./, valueKind: 'color' };
  if (COLOR_CHANNELS_PATTERN.test(value)) return { pattern: /./, valueKind: 'color-channels' };
  const lowered = name.toLowerCase().replace(/^[$@]/, '--');
  return CUSTOM_PROPERTY_RULES.find((rule) => rule.pattern.test(lowered));
}

const FONT_FILE_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

export function isFontFile(extension: string): boolean {
  return FONT_FILE_EXTENSIONS.has(extension);
}

export function isImageFile(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension);
}

const IMAGE_ROLE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/favicon/i, 'favicon'],
  [/apple-touch/i, 'apple-touch'],
  [/(?:^|[^a-z])(?:og|open-?graph)(?:[^a-z]|$)/i, 'og'],
  [/social|twitter|link-?card|share/i, 'social'],
  [/logo|wordmark/i, 'logo'],
  [/(?:^|[^a-z])mark(?:[^a-z]|$)/i, 'mark'],
  [/brand/i, 'brand'],
  [/icon/i, 'icon'],
];

export function imageRoleHint(file: string): string {
  return IMAGE_ROLE_PATTERNS.find(([pattern]) => pattern.test(file))?.[1] ?? 'other';
}

export type ImageDimensions = { width: number; height: number };

function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    const segmentLength = view.getUint16(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    offset += 2 + segmentLength;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 31) return undefined;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  return undefined;
}

function icoDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[2] !== 1) return undefined;
  return { width: bytes[6] || 256, height: bytes[7] || 256 };
}

function svgDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const rootTag = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes.subarray(0, 8192)))?.[0] ?? '';
  const attributeNumber = (name: string): number | undefined => {
    const value = new RegExp(`\\s${name}\\s*=\\s*["']\\s*((?:\\d+(?:\\.\\d*)?|\\.\\d+))(?:px)?\\s*["']`).exec(rootTag)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const width = attributeNumber('width');
  const height = attributeNumber('height');
  if (width !== undefined && height !== undefined) return { width, height };
  const viewBox = /\sviewBox\s*=\s*["']([^"']*)["']/.exec(rootTag)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length !== 4 || viewBox.some((part) => !Number.isFinite(part))) return undefined;
  return { width: viewBox[2] ?? 0, height: viewBox[3] ?? 0 };
}

export function rasterDimensions(bytes: Uint8Array, extension: string): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readerByExtension: Record<string, () => ImageDimensions | undefined> = {
    '.png': () => pngDimensions(bytes, view),
    '.gif': () => gifDimensions(bytes, view),
    '.jpg': () => jpegDimensions(bytes, view),
    '.jpeg': () => jpegDimensions(bytes, view),
    '.webp': () => webpDimensions(bytes, view),
    '.ico': () => icoDimensions(bytes),
    '.svg': () => svgDimensions(bytes),
  };
  return readerByExtension[extension]?.();
}

const TYPOGRAPHIC_CHAR_NAMES: Record<string, string> = {
  '\u2014': 'em-dash', '\u2013': 'en-dash', '\u2026': 'ellipsis', '\u2018': 'left-single-quote', '\u2019': 'right-single-quote',
  '\u201c': 'left-double-quote', '\u201d': 'right-double-quote', '\u2122': 'trademark', '\u00ae': 'registered', '\u00a9': 'copyright',
};
const TYPOGRAPHIC_CHAR_PATTERN = /[\u2013\u2014\u2026\u2018\u2019\u201c\u201d\u2122\u00ae\u00a9]|\p{Extended_Pictographic}/gu;

const MAX_PRODUCT_NAME_LENGTH = 64;

export function locatorFrom(location: SourceLocation, text: string): IndexLocator {
  return (index) => advanceLocation(location, text.slice(0, index));
}

export function productNamePatternFor(names: string[]): RegExp | undefined {
  const alternatives = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 3))]
    .map((name) => name.slice(0, MAX_PRODUCT_NAME_LENGTH).split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter(Boolean).join('[\\s_.-]*'))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (alternatives.length === 0) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

export function addProseFindings(collector: FindingCollector, text: string, locate: IndexLocator, context: ScanContext, detail: FindingDetail): void {
  for (const match of text.matchAll(TYPOGRAPHIC_CHAR_PATTERN)) {
    const name = TYPOGRAPHIC_CHAR_NAMES[match[0]] ?? 'emoji';
    addFinding(collector, 'typographic-char', locate(match.index), match[0], name, { ...detail, codePoint: `U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}` });
  }
  if (!context.productNamePattern) return;
  for (const match of text.matchAll(context.productNamePattern)) {
    addFinding(collector, 'product-name', locate(match.index), match[0], match[0].toLowerCase().replace(/[\s_.-]+/g, ''), { ...detail, form: match[0] });
  }
}

export function addUiText(collector: FindingCollector, text: string, locate: IndexLocator, context: ScanContext, detail: FindingDetail): void {
  const collapsed = collapseWhitespace(text);
  if (!/\p{L}/u.test(collapsed)) return;
  const leadingWhitespaceLength = /^\s*/.exec(text)?.[0].length ?? 0;
  addFinding(collector, 'ui-text', locate(leadingWhitespaceLength), collapsed, collapsed.toLowerCase(), detail);
  addProseFindings(collector, text, locate, context, detail);
}

const TAILWIND_SIZE_NAMES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);
const TAILWIND_WEIGHT_NAMES = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black']);
const TAILWIND_TRANSFORMS: Record<string, string> = { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', 'normal-case': 'none' };

function tailwindKind(utility: string): FindingKind | undefined {
  const textMatch = /^text-(?:\[(.+)\]|([\w-]+?))(?:\/[\w.[\]-]+)?$/.exec(utility);
  if (textMatch?.[1] !== undefined) return isSizeToken(textMatch[1].replace(/^length:/, '')) ? 'font-size' : undefined;
  if (textMatch?.[2] !== undefined) return TAILWIND_SIZE_NAMES.has(textMatch[2]) ? 'font-size' : undefined;
  const fontMatch = /^font-(?:\[(\d+)\]|(\w+))$/.exec(utility);
  if (fontMatch?.[1] || (fontMatch?.[2] && TAILWIND_WEIGHT_NAMES.has(fontMatch[2]))) return 'font-weight';
  if (/^tracking-(?:\[.+\]|[\w-]+)$/.test(utility)) return 'letter-spacing';
  if (/^leading-(?:\[.+\]|[\w-]+)$/.test(utility)) return 'line-height';
  if (TAILWIND_TRANSFORMS[utility]) return 'text-transform';
  if (/^rounded(?:-[\w[\].-]+)?$/.test(utility)) return 'radius';
  if (/^shadow(?:-[\w[\].-]+)?$/.test(utility)) return 'shadow';
  return undefined;
}

export function addTailwindClassFindings(collector: FindingCollector, classList: string, location: SourceLocation, context: ScanContext, detail: FindingDetail): void {
  for (const match of classList.matchAll(/\S+/g)) {
    const utility = match[0].split(':').pop()?.replace(/^!/, '') ?? '';
    const utilityLocation = advanceLocation(location, classList.slice(0, match.index));
    const kind = tailwindKind(utility);
    const customTextName = /^text-([\w-]+?)(?:\/[\w.[\]-]+)?$/.exec(utility)?.[1];
    if (!kind && customTextName) context.deferredTailwindText.push({ name: customTextName, finding: buildFinding(collector, 'font-size', utilityLocation, match[0], utility, { ...detail, source: 'tailwind' }) });
    if (kind) addFinding(collector, kind, utilityLocation, match[0], utility, { ...detail, source: 'tailwind' });
  }
}

export function resolveDeferredTailwindText(context: ScanContext): UntargetedFinding[] {
  return context.deferredTailwindText.filter((deferred) => context.tailwindTextNames.has(deferred.name)).map((deferred) => deferred.finding);
}
