import { z } from 'zod';
import { contrastRatio } from './contrast.ts';

const Hex = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/, { error: 'a color is lowercase #rrggbb or #rrggbbaa' });
const TokenName = z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'a token name is lowercase kebab-case' });
const Glob = z.string().min(1);
const Why = z.string().min(10, { error: 'every opinion carries a reason of at least 10 characters' });
const Px = z.number().positive();
const Text = z.string().min(1);

const Meta = z.strictObject({ name: Text, version: Text, reviewedAt: z.iso.date() });

const Strategy = z.strictObject({
  mission: Text.max(200),
  vision: Text.max(200),
  values: z.array(z.strictObject({ name: Text, definition: Text })).min(2).max(5),
  positioning: z.strictObject({ audience: Text, offer: Text, differentiator: Text }),
  audiences: z.array(z.strictObject({ name: Text, needs: Text, context: Text })).min(1),
  personality: z.array(z.strictObject({ trait: Text, notTrait: Text })).min(3).max(5),
  archetype: Text.optional(),
  antiReferences: z.array(z.strictObject({ name: Text, why: Why })).min(1),
  principles: z.array(z.strictObject({ name: Text, rule: Text, why: Why })).min(1).max(7),
});

const Naming = z.strictObject({
  productName: Text,
  allowedForms: z.array(z.strictObject({ form: Text, where: z.enum(['cli', 'package', 'url', 'code', 'prose']) })),
  forbiddenForms: z.array(Text),
  tagline: Text.max(80),
  descriptions: z.strictObject({ short: Text.max(80), medium: Text.max(160), long: Text.max(500) }),
  glossary: z.array(z.strictObject({ term: Text, definition: Text, forbiddenAliases: z.array(Text) })),
});

const Logo = z.strictObject({
  mark: z.strictObject({ file: Text, viewBox: Text, pathData: z.array(Text).min(1) }),
  variants: z.array(z.strictObject({
    id: z.enum(['primary', 'mark-only', 'wordmark', 'horizontal', 'stacked', 'favicon', 'app-icon']),
    file: Text,
    use: Text,
  })).min(1),
  clearSpaceRatio: z.number().positive(),
  minSizePx: Px,
  colorways: z.array(z.strictObject({ foreground: TokenName, background: TokenName })).min(1),
  misuse: z.array(Text).min(1),
});

const Color = z.strictObject({
  tokens: z.record(TokenName, z.strictObject({
    value: Hex,
    role: z.enum(['brand', 'neutral', 'surface', 'text', 'border', 'state', 'data']),
    name: Text,
    use: Text,
  })),
  themes: z.record(TokenName, z.strictObject({ label: Text, mode: z.enum(['dark', 'light']), overrides: z.record(TokenName, Hex) })),
  defaultTheme: TokenName,
  pairs: z.array(z.strictObject({ foreground: TokenName, background: TokenName, minContrast: z.union([z.literal(3), z.literal(4.5), z.literal(7)]) })),
  literalColorsAllowedIn: z.array(Glob),
});

const TypeRole = z.strictObject({
  token: TokenName,
  sizePx: Px,
  lineHeight: z.number().positive(),
  weight: z.number().int(),
  trackingEm: z.number(),
  case: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']),
});

const Typography = z.strictObject({
  families: z.array(z.strictObject({ id: TokenName, family: Text, files: z.array(Text), license: Text, fallback: z.array(Text).min(1) })).min(1).max(3),
  scale: z.record(TokenName, TypeRole).refine((roles) => Object.keys(roles).length <= 8, { error: 'a type scale has at most 8 roles' }),
  weights: z.array(z.number().int()).min(1).max(3),
  minSizePx: Px,
  features: z.record(Text, z.enum(['on', 'off'])),
  literalSizesAllowedIn: z.array(Glob),
});

const DesignRules = z.array(z.strictObject({ rule: Text, why: Why }));

const Shape = z.strictObject({
  radius: z.record(TokenName, z.number().nonnegative()),
  spacing: z.record(TokenName, z.number().nonnegative()),
  shadows: z.record(TokenName, Text),
  restingShadow: z.boolean(),
  rules: DesignRules,
});

const Iconography = z.strictObject({
  source: z.strictObject({ library: Text, license: Text }),
  viewBox: Text,
  strokeWidth: z.number().positive(),
  fill: z.enum(['none', 'currentColor']),
  linecap: z.enum(['butt', 'round', 'square']),
  linejoin: z.enum(['miter', 'round', 'bevel']),
  sizesPx: z.array(Px).min(1),
});

const Imagery = z.strictObject({
  direction: z.strictObject({ lighting: Text, composition: Text, colorTreatment: Text, subjects: Text, postProcessing: Text, stock: Text }),
  formats: z.array(z.enum(['webp', 'avif', 'png', 'jpg', 'svg', 'gif'])).min(1),
  maxBytes: z.number().int().positive(),
  mascots: z.strictObject({ allowed: z.boolean(), where: z.array(Glob), why: Why }),
});

const Voice = z.strictObject({
  traits: z.array(Text).min(2).max(5),
  tone: z.array(z.strictObject({ context: Text, tone: Text, example: Text })).min(1),
  formality: z.enum(['casual', 'neutral', 'formal']),
  headingCase: z.enum(['sentence', 'title', 'upper']),
  vocabulary: z.strictObject({
    banned: z.array(z.strictObject({ term: Text, insteadUse: Text.optional(), why: Why })),
    preferred: z.array(z.strictObject({ term: Text, over: z.array(Text).min(1) })),
  }),
  characters: z.array(z.strictObject({ char: z.string().min(1).max(2), action: z.enum(['banned', 'allowed']), replacement: z.string().optional() })),
  examples: z.array(z.strictObject({ onBrand: Text, offBrand: Text, why: Why })).min(1),
});

const Motion = z.strictObject({
  durationsMs: z.record(TokenName, z.number().int().nonnegative()),
  easings: z.record(TokenName, Text),
  reducedMotion: z.literal('required'),
  logoAnimation: Text,
  rules: DesignRules,
});

const Applications = z.array(z.strictObject({
  id: TokenName,
  kind: z.enum(['og-image', 'favicon', 'app-icon', 'social', 'readme', 'docs-site', 'email', 'deck', 'product-ui', 'cli']),
  files: z.array(Glob).min(1),
  template: Text.optional(),
}));

const Accessibility = z.strictObject({ minContrastText: z.literal(4.5), minContrastLarge: z.literal(3), focusRing: Text, minTargetPx: Px });

const Localization = z.strictObject({ locales: z.array(Text).min(1), untranslatable: z.array(Text) });

const Governance = z.strictObject({
  owner: Text,
  reviewers: z.array(Text),
  reviewEveryMonths: z.number().int().positive(),
  exemptions: z.array(z.strictObject({ paths: z.array(Glob).min(1), kinds: z.array(Text).min(1), why: Why })),
});

export const SECTION_SCHEMAS = {
  meta: Meta,
  strategy: Strategy,
  naming: Naming,
  logo: Logo,
  color: Color,
  typography: Typography,
  shape: Shape,
  iconography: Iconography,
  imagery: Imagery,
  voice: Voice,
  motion: Motion,
  applications: Applications,
  accessibility: Accessibility,
  localization: Localization,
  governance: Governance,
} as const;

export type SectionName = keyof typeof SECTION_SCHEMAS;

export const SECTION_NAMES = Object.keys(SECTION_SCHEMAS) as SectionName[];

type BibleShape = { [Section in SectionName]: z.infer<(typeof SECTION_SCHEMAS)[Section]> };

type IssueSink = { addIssue: (issue: { code: 'custom'; path: PropertyKey[]; message: string }) => void };

function reportUnknownToken(bible: BibleShape, tokenName: string, path: PropertyKey[], sink: IssueSink): void {
  if (Object.hasOwn(bible.color.tokens, tokenName)) return;
  sink.addIssue({ code: 'custom', path, message: `names no color token: ${tokenName}` });
}

function everyTokenReferenceResolves(bible: BibleShape, sink: IssueSink): void {
  bible.logo.colorways.forEach((colorway, index) => {
    reportUnknownToken(bible, colorway.foreground, ['logo', 'colorways', index, 'foreground'], sink);
    reportUnknownToken(bible, colorway.background, ['logo', 'colorways', index, 'background'], sink);
  });
  bible.color.pairs.forEach((pair, index) => {
    reportUnknownToken(bible, pair.foreground, ['color', 'pairs', index, 'foreground'], sink);
    reportUnknownToken(bible, pair.background, ['color', 'pairs', index, 'background'], sink);
  });
  for (const [themeId, theme] of Object.entries(bible.color.themes)) {
    for (const tokenName of Object.keys(theme.overrides)) reportUnknownToken(bible, tokenName, ['color', 'themes', themeId, 'overrides', tokenName], sink);
  }
  if (!Object.hasOwn(bible.color.themes, bible.color.defaultTheme)) {
    sink.addIssue({ code: 'custom', path: ['color', 'defaultTheme'], message: `names no theme: ${bible.color.defaultTheme}` });
  }
}

function isOpaque(hex: string): boolean {
  return hex.length === 7 || hex.endsWith('ff');
}

function pairIssueUnderTheme(foregroundHex: string, backgroundHex: string, minContrast: number, themeLabel: string): string | undefined {
  if (!isOpaque(foregroundHex) || !isOpaque(backgroundHex)) return `a contrast pair needs opaque colors${themeLabel}`;
  const ratio = contrastRatio(foregroundHex, backgroundHex);
  if (ratio >= minContrast) return undefined;
  return `contrast ${ratio} is below ${minContrast}${themeLabel}`;
}

function everyPairMeetsItsContrast(bible: BibleShape, sink: IssueSink): void {
  const baseValueByToken = Object.fromEntries(Object.entries(bible.color.tokens).map(([tokenName, token]) => [tokenName, token.value]));
  const valueSets: Array<[string, Record<string, string>]> = [
    ['', baseValueByToken],
    ...Object.entries(bible.color.themes).map(([themeId, theme]): [string, Record<string, string>] => [` under theme ${themeId}`, { ...baseValueByToken, ...theme.overrides }]),
  ];
  bible.color.pairs.forEach((pair, index) => {
    if (!Object.hasOwn(baseValueByToken, pair.foreground) || !Object.hasOwn(baseValueByToken, pair.background)) return;
    const issueMessages = new Set(valueSets.map(([themeLabel, valueByToken]) => pairIssueUnderTheme(valueByToken[pair.foreground] ?? '', valueByToken[pair.background] ?? '', pair.minContrast, themeLabel)));
    for (const message of issueMessages) {
      if (message) sink.addIssue({ code: 'custom', path: ['color', 'pairs', index], message });
    }
  });
}

function typeScaleUsesDeclaredWeightsAndFloor(bible: BibleShape, sink: IssueSink): void {
  for (const [roleName, role] of Object.entries(bible.typography.scale)) {
    if (!bible.typography.weights.includes(role.weight)) {
      sink.addIssue({ code: 'custom', path: ['typography', 'scale', roleName, 'weight'], message: `weight ${role.weight} is not in typography.weights` });
    }
    if (role.sizePx < bible.typography.minSizePx) {
      sink.addIssue({ code: 'custom', path: ['typography', 'scale', roleName, 'sizePx'], message: `size ${role.sizePx}px is below typography.minSizePx` });
    }
  }
}

export const BrandBible = z.strictObject(SECTION_SCHEMAS).superRefine((bible, context) => {
  everyTokenReferenceResolves(bible, context);
  everyPairMeetsItsContrast(bible, context);
  typeScaleUsesDeclaredWeightsAndFloor(bible, context);
});

export type BrandBible = z.infer<typeof BrandBible>;
