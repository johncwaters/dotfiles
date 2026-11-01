import postcss from 'postcss';
import type { AtRule, ChildNode, Container, Declaration, Root, Rule } from 'postcss';
import postcssScss from 'postcss-scss';
import { contrastRatio } from './bible/contrast.ts';
import { blendOver } from './color.ts';
import {
  addFinding, advanceLocation, classifyCustomProperty, collapseWhitespace, durationsInMs, findColorExpressions, findColorLiterals,
  isTokenProperty, kebabCase, normalizeFontFamily, normalizeLength, parseFontShorthand,
} from './findings.ts';
import type { FindingCollector, ShorthandPart, SourceLocation } from './findings.ts';
import type { FindingDetail, FindingKind } from './bible/targets.ts';

export type DeclarationSource = 'css' | 'style-attribute' | 'js-style' | 'canvas' | 'svg-attribute' | 'data-file';

export type CssScanResult = { tailwindTextNames: string[] };

const COLOR_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'outline-color', 'fill', 'stroke', 'caret-color', 'accent-color', 'text-decoration-color', 'column-rule-color',
  'stop-color', 'flood-color', 'lighting-color',
]);

const PASSTHROUGH_TYPOGRAPHY: Record<string, FindingKind> = {
  'font-weight': 'font-weight',
  'letter-spacing': 'letter-spacing',
  'line-height': 'line-height',
  'text-transform': 'text-transform',
  'font-feature-settings': 'font-features',
  'font-variant-ligatures': 'font-features',
};

const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const URL_PATTERN = /url\(\s*(["']?)([^"'()]+)\1\s*\)/g;
const IMPORT_TARGET_PATTERN = /^\s*(?:url\(\s*)?(["']?)([^"'()\s]+)\1/;

function isRadiusProperty(property: string): boolean {
  return property === 'border-radius' || /^border-(?:top|bottom|start|end)-(?:left|right|start|end)-radius$/.test(property);
}

function isMotionProperty(property: string): boolean {
  return /^(?:transition|animation)(?:-|$)/.test(property);
}

function addTypographyFinding(collector: FindingCollector, kind: FindingKind, location: SourceLocation, raw: string, detail: FindingDetail): void {
  const variableName = /^\s*var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)\s*$/.exec(raw)?.[1];
  if (variableName) {
    addFinding(collector, kind, location, raw, variableName, detail);
    return;
  }
  if (kind === 'font-family') {
    addFinding(collector, kind, location, raw, normalizeFontFamily(raw), detail);
    return;
  }
  if (kind === 'text-transform' || kind === 'font-features' || kind === 'motion' || kind === 'shadow') {
    addFinding(collector, kind, location, raw, collapseWhitespace(raw).toLowerCase(), detail);
    return;
  }
  const length = normalizeLength(raw);
  addFinding(collector, kind, location, raw, length.normalized, { ...detail, ...length.detail });
}

function addFontShorthandFindings(collector: FindingCollector, value: string, location: SourceLocation, detail: FindingDetail): void {
  const shorthand = parseFontShorthand(value);
  const partFindings: Array<[FindingKind, ShorthandPart | undefined]> = [['font-size', shorthand.size], ['line-height', shorthand.lineHeight], ['font-weight', shorthand.weight], ['font-family', shorthand.family]];
  for (const [kind, part] of partFindings) {
    if (part) addTypographyFinding(collector, kind, advanceLocation(location, value.slice(0, part.offset)), part.raw, { ...detail, from: 'font-shorthand' });
  }
}

function addCustomPropertyFindings(collector: FindingCollector, property: string, value: string, location: SourceLocation, detail: FindingDetail): void {
  const rule = classifyCustomProperty(property, value);
  const firstColor = findColorLiterals(value)[0];
  const normalizedValue = rule?.valueKind === 'color' && firstColor ? firstColor.normalized : collapseWhitespace(value).toLowerCase();
  addFinding(collector, 'css-token', location, `${property}: ${value}`, `${property}: ${normalizedValue}`, { ...detail, valueKind: rule?.valueKind ?? 'other' });
  if (rule?.findingKind) addTypographyFinding(collector, rule.findingKind, location, value, { ...detail, from: 'custom-property', token: property });
}

function addColorFindings(collector: FindingCollector, property: string, value: string, location: SourceLocation, detail: FindingDetail): void {
  for (const literal of findColorLiterals(value)) {
    addFinding(collector, 'color', advanceLocation(location, value.slice(0, literal.offset)), literal.raw, literal.normalized, detail);
  }
  for (const expression of findColorExpressions(value)) {
    addFinding(collector, 'color-expression', advanceLocation(location, value.slice(0, expression.offset)), expression.raw, expression.normalized, detail);
  }
  const variableMatch = /^var\((--[\w-]+)/.exec(value.trim());
  if (COLOR_PROPERTIES.has(property) && variableMatch?.[1]) addFinding(collector, 'color-expression', location, value.trim(), variableMatch[1], detail);
}

function addAssetReferences(collector: FindingCollector, value: string, location: SourceLocation, detail: FindingDetail): void {
  for (const match of value.matchAll(URL_PATTERN)) {
    const reference = match[2]?.trim() ?? '';
    if (!reference || reference.startsWith('data:') || reference.startsWith('#')) continue;
    const referenceOffset = match.index + match[0].indexOf(reference, 4);
    addFinding(collector, 'asset-reference', advanceLocation(location, value.slice(0, referenceOffset)), reference, reference.split(/[?#]/)[0] ?? reference, { ...detail, slot: 'css:url' });
  }
}

export function addDeclarationFindings(collector: FindingCollector, rawProperty: string, value: string, location: SourceLocation, scopeDetail: FindingDetail, source: DeclarationSource): void {
  const property = kebabCase(rawProperty);
  if (!value.trim()) return;
  const detail: FindingDetail = { ...scopeDetail, property, source };
  addColorFindings(collector, property, value, location, detail);
  if (value.includes('url(')) addAssetReferences(collector, value, location, detail);
  if (isTokenProperty(property)) {
    addCustomPropertyFindings(collector, property, value, location, detail);
    return;
  }
  const passthroughKind = PASSTHROUGH_TYPOGRAPHY[property];
  if (passthroughKind) {
    addTypographyFinding(collector, passthroughKind, location, value, detail);
    return;
  }
  if (property === 'font-size') addTypographyFinding(collector, 'font-size', location, value, detail);
  if (property === 'font-family') addTypographyFinding(collector, 'font-family', location, value, detail);
  if (property === 'font') addFontShorthandFindings(collector, value, location, detail);
  if (isRadiusProperty(property)) addTypographyFinding(collector, 'radius', location, value, detail);
  if (property === 'box-shadow' || property === 'text-shadow' || (property === 'filter' && value.includes('drop-shadow('))) {
    addTypographyFinding(collector, 'shadow', location, value, detail);
  }
  if (isMotionProperty(property)) {
    const durations = durationsInMs(value);
    addTypographyFinding(collector, 'motion', location, value, durations.length > 0 ? { ...detail, durationsMs: durations.join(',') } : detail);
  }
}

function enclosingAtRules(node: ChildNode): AtRule[] {
  const atRules: AtRule[] = [];
  for (let parent: Container | Root | undefined = node.parent as Container | undefined; parent && parent.type !== 'root'; parent = parent.parent as Container | undefined) {
    if (parent.type === 'atrule') atRules.unshift(parent as AtRule);
  }
  return atRules;
}

function nearestRule(node: ChildNode): Rule | undefined {
  for (let parent = node.parent as Container | undefined; parent && parent.type !== 'root'; parent = parent.parent as Container | undefined) {
    if (parent.type === 'rule') return parent as Rule;
  }
  return undefined;
}

function scopeOf(node: ChildNode): FindingDetail {
  const scope: FindingDetail = {};
  const rule = nearestRule(node);
  if (rule) scope.scope = collapseWhitespace(rule.selector);
  const atRuleText = enclosingAtRules(node).map((atRule) => collapseWhitespace(`@${atRule.name} ${atRule.params}`)).join(' ');
  if (atRuleText) scope.media = atRuleText;
  return scope;
}

type LocationMapper = (line: number, column: number) => SourceLocation;

function locationOf(node: ChildNode, mapLocation: LocationMapper): SourceLocation {
  const start = node.source?.start;
  return mapLocation(start?.line ?? 1, start?.column ?? 1);
}

function declarationValueLocation(declaration: Declaration, mapLocation: LocationMapper): SourceLocation {
  const start = locationOf(declaration, mapLocation);
  const between = typeof declaration.raws.between === 'string' ? declaration.raws.between : ': ';
  return advanceLocation(start, `${declaration.prop}${between}`);
}

function blankComments(sourceValue: string): string {
  return sourceValue.replace(CSS_COMMENT_PATTERN, (comment) => comment.replace(/[^\n]/g, ' ')).trimEnd();
}

function sourceAlignedValue(declaration: Declaration): string {
  return blankComments(declaration.raws.value?.raw ?? declaration.value);
}

function sourceAlignedParams(atRule: AtRule): string {
  return blankComments(atRule.raws.params?.raw ?? atRule.params);
}

function isInsideFontFace(node: ChildNode): boolean {
  return enclosingAtRules(node).some((atRule) => atRule.name.toLowerCase() === 'font-face');
}

function addFontFaceFinding(collector: FindingCollector, atRule: AtRule, mapLocation: LocationMapper): void {
  const descriptorByName = new Map<string, string>();
  let sourceDeclaration: Declaration | undefined;
  atRule.each((child) => {
    if (child.type !== 'decl') return;
    descriptorByName.set(child.prop.toLowerCase(), child.value);
    if (child.prop.toLowerCase() === 'src') sourceDeclaration = child;
  });
  const family = descriptorByName.get('font-family') ?? '';
  const sources = descriptorByName.get('src') ?? '';
  const detail: FindingDetail = { src: collapseWhitespace(sources) };
  const weight = descriptorByName.get('font-weight');
  if (weight) detail.weight = weight;
  addFinding(collector, 'font-face', locationOf(atRule, mapLocation), family, normalizeFontFamily(family), detail);
  if (!sourceDeclaration) return;
  addAssetReferences(collector, sourceAlignedValue(sourceDeclaration), declarationValueLocation(sourceDeclaration, mapLocation), { property: 'src', source: 'css', scope: '@font-face' });
}

function addContrastPair(collector: FindingCollector, rule: Rule, mapLocation: LocationMapper): void {
  let foreground: string | undefined;
  let background: string | undefined;
  rule.each((child) => {
    if (child.type !== 'decl') return;
    const property = child.prop.toLowerCase();
    const firstColor = findColorLiterals(child.value)[0]?.normalized;
    if (property === 'color') foreground = firstColor;
    if ((property === 'background' || property === 'background-color') && !findColorExpressions(child.value).length) background = firstColor;
  });
  if (!foreground || !background) return;
  const pairText = `${foreground} on ${background}`;
  const detail: FindingDetail = { scope: collapseWhitespace(rule.selector) };
  if (background.length === 9) {
    addFinding(collector, 'contrast-pair', locationOf(rule, mapLocation), pairText, pairText, { ...detail, unrated: 'translucent background' });
    return;
  }
  addFinding(collector, 'contrast-pair', locationOf(rule, mapLocation), pairText, pairText, { ...detail, ratio: contrastRatio(blendOver(foreground, background), background) });
}

function addAtRuleFindings(collector: FindingCollector, atRule: AtRule, mapLocation: LocationMapper): void {
  const name = atRule.name.toLowerCase();
  if (name.endsWith(':')) {
    addDeclarationFindings(collector, `@${atRule.name.slice(0, -1)}`, sourceAlignedParams(atRule), advanceLocation(locationOf(atRule, mapLocation), `@${atRule.name}${atRule.raws.afterName ?? ''}`), scopeOf(atRule), 'css');
    return;
  }
  if (name === 'import') {
    const importTarget = IMPORT_TARGET_PATTERN.exec(atRule.params)?.[2];
    if (importTarget) addFinding(collector, 'asset-reference', locationOf(atRule, mapLocation), importTarget, importTarget.split(/[?#]/)[0] ?? importTarget, { slot: 'css:import', source: 'css' });
    return;
  }
  if (name === 'font-face') {
    addFontFaceFinding(collector, atRule, mapLocation);
    return;
  }
  if (name.endsWith('keyframes')) {
    addFinding(collector, 'motion', locationOf(atRule, mapLocation), `@${atRule.name} ${atRule.params}`, `@keyframes ${atRule.params.trim()}`, { property: 'keyframes', source: 'css' });
    return;
  }
  if (name === 'media' && /prefers-reduced-motion/i.test(atRule.params)) {
    addFinding(collector, 'motion', locationOf(atRule, mapLocation), `@media ${atRule.params}`, collapseWhitespace(atRule.params).toLowerCase(), { property: 'reduced-motion', source: 'css' });
  }
}

function tailwindTextName(declaration: Declaration): string | undefined {
  const atRules = enclosingAtRules(declaration);
  if (!atRules.some((atRule) => atRule.name.toLowerCase() === 'theme')) return undefined;
  const nameMatch = /^--text-([\w-]+?)$/.exec(declaration.prop);
  if (!nameMatch?.[1] || nameMatch[1].includes('--')) return undefined;
  return nameMatch[1];
}

export type CssParseOptions = { syntax: 'css' | 'scss'; startLine?: number; startColumn?: number; source?: DeclarationSource };

export function scanCss(collector: FindingCollector, cssText: string, options: CssParseOptions): CssScanResult {
  const root = options.syntax === 'scss' ? postcssScss.parse(cssText) : postcss.parse(cssText);
  const startLine = options.startLine ?? 1;
  const startColumn = options.startColumn ?? 1;
  const mapLocation: LocationMapper = (line, column) => ({ line: startLine + line - 1, column: line === 1 ? startColumn + column - 1 : column });
  const tailwindTextNames: string[] = [];
  root.walk((node) => {
    if (node.type === 'atrule') addAtRuleFindings(collector, node, mapLocation);
    if (node.type === 'rule') addContrastPair(collector, node, mapLocation);
    if (node.type !== 'decl' || isInsideFontFace(node)) return;
    const textName = tailwindTextName(node);
    if (textName) tailwindTextNames.push(textName);
    addDeclarationFindings(collector, node.prop, sourceAlignedValue(node), declarationValueLocation(node, mapLocation), scopeOf(node), options.source ?? 'css');
  });
  return { tailwindTextNames };
}
