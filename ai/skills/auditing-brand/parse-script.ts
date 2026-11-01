import { parseSync, rawTransferSupported, Visitor } from 'oxc-parser';
import type { ParserOptions } from 'oxc-parser';
import { normalizeColor } from './color.ts';
import { addFinding, addProseFindings, addTailwindClassFindings, addUiText, collapseWhitespace, isTokenProperty, kebabCase, locatorFrom } from './findings.ts';
import type { FindingCollector, IndexLocator, ScanContext, SourceLocation } from './findings.ts';
import { addDeclarationFindings, scanCss } from './parse-css.ts';
import type { DeclarationSource } from './parse-css.ts';
import { DATA_STYLE_PROPERTY_PATTERN } from './parse-docs.ts';
import { addAssetReferenceFindings, decodeCharacterReferences, scanMarkup, UI_TEXT_ATTRIBUTES } from './parse-markup.ts';
import type { DecodedText } from './parse-markup.ts';

type SyntaxNode = { type: string; start: number; end: number; [field: string]: unknown };

type StringValue = { value: string; contentStart: number; rawText: string; decoded: DecodedText | undefined };

const ESCAPE_PATTERN = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/y;
const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
const CSS_TAG_PATTERN = /^(?:css|styled(?:\.\w+)*|createGlobalStyle|injectGlobal|keyframes|globalCss|sx)$/;
const MARKUP_TAG_PATTERN = /^(?:html|svg)$/;
const CANVAS_PROPERTIES = new Set(['font', 'fillStyle', 'strokeStyle', 'shadowColor']);
const SVG_PRESENTATION_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color', 'font-size', 'font-family', 'font-weight', 'letter-spacing']);
const MIN_SVG_PATH_LENGTH = 25;
const PARSER_OPTIONS: ParserOptions & { experimentalRawTransfer?: boolean } = { astType: 'js', experimentalRawTransfer: rawTransferSupported() };
const PLAIN_JS_FILE_PATTERN = /\.[cm]?js$/i;
const PLAIN_JS_PARSER_OPTIONS: typeof PARSER_OPTIONS = { ...PARSER_OPTIONS, lang: 'jsx' };

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object' && value !== null && typeof (value as SyntaxNode).type === 'string';
}

function propertyKeyName(key: unknown): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === 'Identifier' || key.type === 'JSXIdentifier') return String(key.name);
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
  return undefined;
}

function calleeName(tag: unknown): string {
  if (!isNode(tag)) return '';
  if (tag.type === 'Identifier') return String(tag.name);
  if (tag.type === 'MemberExpression') return `${calleeName(tag.object)}.${propertyKeyName(tag.property) ?? ''}`;
  if (tag.type === 'CallExpression') return calleeName(tag.callee);
  return '';
}

function escapeAt(raw: string, index: number): { decoded: string; width: number } | undefined {
  ESCAPE_PATTERN.lastIndex = index;
  const match = ESCAPE_PATTERN.exec(raw);
  if (!match) return undefined;
  const [whole, bracedHex, fourHex, twoHex, lineContinuation, single] = match;
  const hex = bracedHex ?? fourHex ?? twoHex;
  const codePoint = hex === undefined ? undefined : Number.parseInt(hex, 16);
  if (codePoint !== undefined) return codePoint > 0x10ffff ? undefined : { decoded: String.fromCodePoint(codePoint), width: whole.length };
  if (lineContinuation) return { decoded: '', width: whole.length };
  return { decoded: SIMPLE_ESCAPES[single ?? ''] ?? single ?? '', width: whole.length };
}

function decodeStringEscapes(raw: string): DecodedText {
  let text = '';
  const rawIndexes: number[] = [];
  let rawIndex = 0;
  while (rawIndex < raw.length) {
    const escape = raw[rawIndex] === '\\' ? escapeAt(raw, rawIndex) : undefined;
    const decoded = escape?.decoded ?? raw[rawIndex] ?? '';
    for (let unit = 0; unit < decoded.length; unit++) rawIndexes.push(rawIndex);
    text += decoded;
    rawIndex += escape?.width ?? 1;
  }
  return { text, rawIndexOf: (decodedIndex) => rawIndexes[decodedIndex] ?? raw.length };
}

function escapedStringValue(value: string, rawText: string, contentStart: number): StringValue {
  const decoded = decodeStringEscapes(rawText);
  return { value, contentStart, rawText, decoded: decoded.text === value ? decoded : undefined };
}

function verbatimStringValue(value: string, contentStart: number): StringValue {
  return { value, contentStart, rawText: value, decoded: { text: value, rawIndexOf: (decodedIndex) => decodedIndex } };
}

function stringValueOf(node: unknown): StringValue | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return escapedStringValue(node.value, String(node.raw ?? '').slice(1, -1), node.start + 1);
  const quasis = node.type === 'TemplateLiteral' ? (node.quasis as SyntaxNode[]) : [];
  const onlyQuasi = quasis[0];
  if (quasis.length !== 1 || !onlyQuasi) return undefined;
  const quasiValue = onlyQuasi.value as { cooked?: string | null; raw: string };
  return escapedStringValue(quasiValue.cooked ?? quasiValue.raw, quasiValue.raw, onlyQuasi.start);
}

function jsxAttributeValueOf(node: unknown): unknown {
  return isNode(node) && node.type === 'JSXExpressionContainer' ? node.expression : node;
}

function isStyleProperty(property: string): boolean {
  return isTokenProperty(property) || DATA_STYLE_PROPERTY_PATTERN.test(property);
}

function templateTextWithBlankExpressions(source: string, template: SyntaxNode): { text: string; start: number } {
  const quasis = template.quasis as SyntaxNode[];
  const start = quasis[0]?.start ?? template.start;
  const end = quasis[quasis.length - 1]?.end ?? template.end;
  let text = '';
  let cursor = start;
  for (const quasi of quasis) {
    text += source.slice(cursor, quasi.start).replace(/[^\n]/g, ' ');
    text += source.slice(quasi.start, quasi.end);
    cursor = quasi.end;
  }
  return { text: text + source.slice(cursor, end).replace(/[^\n]/g, ' '), start };
}

export function scanScript(collector: FindingCollector, text: string, context: ScanContext): void {
  const parsed = parseSync(collector.file, text, PLAIN_JS_FILE_PATTERN.test(collector.file) ? PLAIN_JS_PARSER_OPTIONS : PARSER_OPTIONS);
  const firstError = parsed.errors[0];
  if (firstError && parsed.program.body.length === 0) throw new Error(firstError.message);
  const locationAt = (offset: number): SourceLocation => collector.source.locationAt(offset);
  const handledStringStarts = new Set<number>();
  const openJsxElements: string[] = [];

  const locatorOf = (stringValue: StringValue): IndexLocator | undefined => {
    const decoded = stringValue.decoded;
    if (!decoded) return undefined;
    const rawLocator = locatorFrom(locationAt(stringValue.contentStart), stringValue.rawText);
    return (decodedIndex) => rawLocator(decoded.rawIndexOf(decodedIndex));
  };

  const addStyleValue = (property: string, valueNode: unknown, source: DeclarationSource, detail: Record<string, string>): void => {
    const stringValue = stringValueOf(valueNode);
    if (stringValue) {
      handledStringStarts.add(stringValue.contentStart);
      addDeclarationFindings(collector, property, stringValue.value, locationAt(stringValue.contentStart), detail, source);
      return;
    }
    if (isNode(valueNode) && valueNode.type === 'Literal' && typeof valueNode.value === 'number') {
      addDeclarationFindings(collector, property, String(valueNode.value), locationAt(valueNode.start), detail, source);
    }
  };

  const scanCssText = (cssText: string, start: SourceLocation, source: 'css' | 'style-attribute', label: string): void => {
    try {
      const { tailwindTextNames } = scanCss(collector, cssText, { syntax: source === 'css' ? 'scss' : 'css', startLine: start.line, startColumn: start.column, source });
      for (const name of tailwindTextNames) context.tailwindTextNames.add(name);
    } catch (parseError) {
      addFinding(collector, 'skipped', start, label, 'embedded-css-parse-error', { reason: `embedded-css-parse-error: ${(parseError as Error).message.split('\n')[0]}` });
    }
  };

  const scanEmbeddedCss = (template: SyntaxNode, tag: string): void => {
    const embedded = templateTextWithBlankExpressions(text, template);
    scanCssText(embedded.text, locationAt(embedded.start), 'css', tag);
  };

  const scanEmbeddedMarkup = (template: SyntaxNode): void => {
    const embedded = templateTextWithBlankExpressions(text, template);
    for (const quasi of template.quasis as SyntaxNode[]) handledStringStarts.add(quasi.start);
    scanMarkup(collector, embedded.text, context, embedded.start);
  };

  const visitor = new Visitor({
    Property(node: SyntaxNode) {
      const key = propertyKeyName(node.key);
      if (!key || node.computed) return;
      const property = isTokenProperty(key) ? key : kebabCase(key.replace(/_/g, '-'));
      if (isStyleProperty(property)) addStyleValue(property, node.value, 'js-style', { key });
    },
    AssignmentExpression(node: SyntaxNode) {
      const target = node.left;
      if (!isNode(target) || target.type !== 'MemberExpression') return;
      const key = propertyKeyName(target.property);
      if (!key || target.computed) return;
      if (CANVAS_PROPERTIES.has(key)) {
        addStyleValue(key === 'font' ? 'font' : 'color', node.right, 'canvas', { key });
        return;
      }
      const property = kebabCase(key);
      if (isStyleProperty(property) && /\.style$/.test(calleeName(target.object))) addStyleValue(property, node.right, 'js-style', { key });
    },
    CallExpression(node: SyntaxNode) {
      const callee = calleeName(node.callee);
      const [nameArgument, valueArgument] = node.arguments as unknown[];
      const propertyName = stringValueOf(nameArgument)?.value;
      if (!callee.endsWith('.setProperty') || !propertyName) return;
      addStyleValue(propertyName, valueArgument, 'js-style', { key: propertyName });
    },
    TaggedTemplateExpression(node: SyntaxNode) {
      const tag = calleeName(node.tag);
      if (CSS_TAG_PATTERN.test(tag)) {
        for (const quasi of (node.quasi as SyntaxNode).quasis as SyntaxNode[]) handledStringStarts.add(quasi.start);
        scanEmbeddedCss(node.quasi as SyntaxNode, tag);
        return;
      }
      if (MARKUP_TAG_PATTERN.test(tag)) scanEmbeddedMarkup(node.quasi as SyntaxNode);
    },
    TemplateLiteral(node: SyntaxNode) {
      const quasis = node.quasis as SyntaxNode[];
      if (handledStringStarts.has(quasis[0]?.start ?? -1)) return;
      const firstText = (quasis[0]?.value as { raw: string } | undefined)?.raw ?? '';
      if (/^\s*<[a-z!]/i.test(firstText)) {
        scanEmbeddedMarkup(node);
        return;
      }
      for (const quasi of quasis) {
        const rawText = (quasi.value as { raw: string }).raw;
        addStringFindings(escapedStringValue(decodeStringEscapes(rawText).text, rawText, quasi.start));
      }
    },
    Literal(node: SyntaxNode) {
      const stringValue = stringValueOf(node);
      if (!stringValue || handledStringStarts.has(stringValue.contentStart)) return;
      addStringFindings(stringValue);
    },
    JSXElement(node: SyntaxNode) {
      openJsxElements.push(propertyKeyName((node.openingElement as SyntaxNode).name) ?? 'jsx');
    },
    'JSXElement:exit'() {
      openJsxElements.pop();
    },
    JSXAttribute(node: SyntaxNode) {
      const name = propertyKeyName(node.name);
      const valueNode = jsxAttributeValueOf(node.value);
      const isVerbatim = isNode(node.value) && node.value.type === 'Literal' && typeof node.value.value === 'string';
      const stringValue = isVerbatim ? verbatimStringValue(String((node.value as SyntaxNode).value), (node.value as SyntaxNode).start + 1) : stringValueOf(valueNode);
      const element = openJsxElements[openJsxElements.length - 1] ?? 'jsx';
      const isClassAttribute = name === 'className' || name === 'class';
      if (isClassAttribute && !stringValue && isNode(valueNode) && valueNode.type === 'TemplateLiteral') {
        for (const quasi of valueNode.quasis as SyntaxNode[]) {
          handledStringStarts.add(quasi.start);
          addTailwindClassFindings(collector, (quasi.value as { raw: string }).raw, locationAt(quasi.start), context, { slot: `${element}:class` });
        }
        return;
      }
      if (!name || !stringValue) return;
      handledStringStarts.add(stringValue.contentStart);
      const location = locationAt(stringValue.contentStart);
      const property = kebabCase(name);
      if (name === 'style') scanCssText(stringValue.value, location, 'style-attribute', 'style');
      if (isClassAttribute) addTailwindClassFindings(collector, stringValue.value, location, context, { slot: `${element}:class` });
      if (UI_TEXT_ATTRIBUTES.has(property)) addJsxUiText(stringValue, `${element}:${property}`, isVerbatim);
      if (property === 'alt') addFinding(collector, 'copy-slot', location, collapseWhitespace(stringValue.value), collapseWhitespace(stringValue.value).toLowerCase(), { slot: 'alt' });
      addAssetReferenceFindings(collector, element, name === 'xlinkHref' ? 'xlink:href' : name.toLowerCase(), stringValue.value, location);
      if (openJsxElements.includes('svg') && SVG_PRESENTATION_ATTRIBUTES.has(property)) addDeclarationFindings(collector, property, stringValue.value, location, { element }, 'svg-attribute');
      if (name === 'd' && element === 'path' && stringValue.value.length >= MIN_SVG_PATH_LENGTH) {
        addFinding(collector, 'svg-path', location, stringValue.value.slice(0, 120), collapseWhitespace(stringValue.value.replace(/,/g, ' ')), { length: stringValue.value.length });
      }
    },
    JSXText(node: SyntaxNode) {
      const element = openJsxElements[openJsxElements.length - 1] ?? 'jsx';
      addJsxUiText(verbatimStringValue(String(node.raw ?? node.value), node.start), element, true);
    },
  });

  const addJsxUiText = (stringValue: StringValue, slot: string, decodesEntities: boolean): void => {
    const valueLocator = locatorOf(stringValue);
    if (!valueLocator) return addUnmappedString(stringValue);
    const entities = decodesEntities ? decodeCharacterReferences(stringValue.value) : { text: stringValue.value, rawIndexOf: (decodedIndex: number) => decodedIndex };
    addUiText(collector, entities.text, (decodedIndex) => valueLocator(entities.rawIndexOf(decodedIndex)), context, { slot });
  };

  const addUnmappedString = (stringValue: StringValue): void => {
    addFinding(collector, 'skipped', locationAt(stringValue.contentStart), stringValue.rawText.slice(0, 120), 'unmapped-string-escape', { reason: 'unmapped-string-escape' });
  };

  const addStringFindings = (stringValue: StringValue): void => {
    const color = normalizeColor(stringValue.value);
    if (color) {
      addFinding(collector, 'color', locationAt(stringValue.contentStart), stringValue.value.trim(), color, { source: 'js-string' });
      return;
    }
    if (!/\s/.test(stringValue.value) || !/\p{L}{2}/u.test(stringValue.value)) return;
    const valueLocator = locatorOf(stringValue);
    if (!valueLocator) return addUnmappedString(stringValue);
    addProseFindings(collector, stringValue.value, valueLocator, context, { slot: 'js-string' });
  };

  visitor.visit(parsed.program);
}
