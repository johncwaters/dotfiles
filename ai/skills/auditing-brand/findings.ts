import { normalizeColor } from './color.ts';
import type { FindingDetail, FindingKind, UntargetedFinding } from './bible/targets.ts';

export type SourceLocation = { line: number; column: number };

export type SourceText = { text: string; lineText: (line: number) => string; locationAt: (offset: number) => SourceLocation };

export type FindingCollector = { file: string; source: SourceText; findings: UntargetedFinding[] };

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
  const context = location.line > 0 ? collector.source.lineText(location.line).trim().slice(0, MAX_CONTEXT_LENGTH) : '';
  const finding: UntargetedFinding = { kind, file: collector.file, line: location.line, column: location.column, raw, normalized };
  if (context) finding.context = context;
  if (detail && Object.keys(detail).length > 0) finding.detail = detail;
  collector.findings.push(finding);
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

export type FontShorthand = { size?: string; lineHeight?: string; weight?: string; family?: string };

export function parseFontShorthand(value: string): FontShorthand {
  const tokens = splitTopLevel(value, ' ');
  const sizeIndex = tokens.findIndex((token) => isSizeToken(token.split('/')[0] ?? ''));
  if (sizeIndex === -1) return {};
  const [size, lineHeight] = (tokens[sizeIndex] ?? '').split('/');
  const weight = tokens.slice(0, sizeIndex).find(isWeightToken);
  const family = tokens.slice(sizeIndex + 1).join(' ');
  const shorthand: FontShorthand = { size };
  if (lineHeight) shorthand.lineHeight = lineHeight;
  if (weight) shorthand.weight = weight;
  if (family) shorthand.family = family;
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

export function rasterDimensions(bytes: Uint8Array, extension: string): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readerByExtension: Record<string, () => ImageDimensions | undefined> = {
    '.png': () => pngDimensions(bytes, view),
    '.gif': () => gifDimensions(bytes, view),
    '.jpg': () => jpegDimensions(bytes, view),
    '.jpeg': () => jpegDimensions(bytes, view),
    '.webp': () => webpDimensions(bytes, view),
    '.ico': () => icoDimensions(bytes),
  };
  return readerByExtension[extension]?.();
}
