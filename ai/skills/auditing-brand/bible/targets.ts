export const FINDING_KINDS = [
  'color', 'color-expression', 'css-token', 'contrast-pair',
  'font-family', 'font-face', 'font-file', 'font-size', 'font-weight', 'letter-spacing', 'line-height', 'text-transform', 'font-features',
  'radius', 'spacing', 'shadow', 'motion',
  'svg-path', 'svg-icon', 'image-asset', 'asset-reference',
  'copy-slot', 'product-name', 'ui-text', 'typographic-char',
  'brand-doc', 'brand-doc-section', 'locale-file', 'license-file', 'codeowners', 'skipped',
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export const BIBLE_TARGETS = [
  'naming.productName', 'naming.tagline', 'naming.descriptions', 'naming.glossary', 'strategy',
  'logo.mark', 'logo.variants', 'color.tokens', 'color.pairs', 'color.themes',
  'typography.families', 'typography.scale', 'typography.features', 'shape.radius', 'shape.spacing', 'shape.shadows',
  'iconography', 'imagery', 'voice.vocabulary', 'voice.characters', 'voice.headingCase', 'motion',
  'applications', 'localization', 'governance', 'none',
] as const;

export type BibleTarget = (typeof BIBLE_TARGETS)[number];

export type FindingDetail = Record<string, string | number>;

export type Finding = {
  kind: FindingKind;
  file: string;
  line: number;
  column: number;
  raw: string;
  normalized: string;
  target: BibleTarget;
  context?: string;
  detail?: FindingDetail;
};

export type UntargetedFinding = Omit<Finding, 'target'>;

const TARGET_BY_TOKEN_VALUE_KIND: Record<string, BibleTarget> = {
  color: 'color.tokens', 'font-size': 'typography.scale', 'font-weight': 'typography.scale', 'line-height': 'typography.scale',
  'letter-spacing': 'typography.scale', 'font-family': 'typography.families', radius: 'shape.radius', spacing: 'shape.spacing',
  shadow: 'shape.shadows', motion: 'motion',
};

const TARGET_BY_IMAGE_ROLE: Record<string, BibleTarget> = {
  logo: 'logo.variants', mark: 'logo.variants', brand: 'logo.variants', favicon: 'logo.variants', 'apple-touch': 'logo.variants',
  icon: 'iconography', og: 'applications', social: 'applications',
};

const TARGET_BY_COPY_SLOT_PREFIX: ReadonlyArray<[string, BibleTarget]> = [
  ['package:name', 'naming.productName'], ['manifest:name', 'naming.productName'], ['manifest:short_name', 'naming.productName'],
  ['meta:application-name', 'naming.productName'], ['readme:h1', 'naming.productName'], ['og:site_name', 'naming.productName'],
  ['readme:bold', 'naming.tagline'], ['html:h1', 'naming.tagline'], ['alt', 'voice.vocabulary'], ['meta:theme-color', 'color.tokens'],
  ['package:keywords', 'naming.glossary'],
];

const TARGET_BY_HEADING_WORD: ReadonlyArray<[RegExp, BibleTarget]> = [
  [/\b(voice|tone|writing|words?|vocabulary|copy)\b/i, 'voice.vocabulary'],
  [/\b(colou?rs?|palette)\b/i, 'color.tokens'],
  [/\b(typography|type|fonts?)\b/i, 'typography.scale'],
  [/\b(logo|mark)\b/i, 'logo.mark'],
  [/\b(icons?|iconography)\b/i, 'iconography'],
  [/\b(imagery|photography|images?|illustrations?)\b/i, 'imagery'],
  [/\b(motion|animations?)\b/i, 'motion'],
  [/\b(elevation|shadows?|radius|spacing|layout)\b/i, 'shape.spacing'],
  [/\b(glossary|terms|lexicon|naming|names?)\b/i, 'naming.glossary'],
];

function detailText(finding: UntargetedFinding, key: string): string {
  return String(finding.detail?.[key] ?? '');
}

function targetOfCopySlot(finding: UntargetedFinding): BibleTarget {
  const slot = detailText(finding, 'slot');
  const matchedTarget = TARGET_BY_COPY_SLOT_PREFIX.find(([slotPrefix]) => slot.startsWith(slotPrefix));
  return matchedTarget ? matchedTarget[1] : 'naming.descriptions';
}

function targetOfHeading(finding: UntargetedFinding): BibleTarget {
  const matchedTarget = TARGET_BY_HEADING_WORD.find(([headingPattern]) => headingPattern.test(finding.raw));
  return matchedTarget ? matchedTarget[1] : 'strategy';
}

function targetOfLicensedFile(finding: UntargetedFinding): BibleTarget {
  if (/font|ofl|mono|sans|serif/i.test(finding.file)) return 'typography.families';
  return /icon/i.test(finding.file) ? 'iconography' : 'governance';
}

const TARGET_BY_KIND: Record<FindingKind, BibleTarget | ((finding: UntargetedFinding) => BibleTarget)> = {
  color: 'color.tokens',
  'color-expression': 'color.tokens',
  'css-token': (finding) => TARGET_BY_TOKEN_VALUE_KIND[detailText(finding, 'valueKind')] ?? 'color.tokens',
  'contrast-pair': 'color.pairs',
  'font-family': 'typography.families',
  'font-face': 'typography.families',
  'font-file': 'typography.families',
  'font-size': 'typography.scale',
  'font-weight': 'typography.scale',
  'letter-spacing': 'typography.scale',
  'line-height': 'typography.scale',
  'text-transform': 'typography.scale',
  'font-features': 'typography.features',
  radius: 'shape.radius',
  spacing: 'shape.spacing',
  shadow: 'shape.shadows',
  motion: 'motion',
  'svg-path': 'logo.mark',
  'svg-icon': 'iconography',
  'image-asset': (finding) => TARGET_BY_IMAGE_ROLE[detailText(finding, 'role')] ?? 'imagery',
  'asset-reference': 'applications',
  'copy-slot': targetOfCopySlot,
  'product-name': 'naming.productName',
  'ui-text': 'voice.vocabulary',
  'typographic-char': 'voice.characters',
  'brand-doc': 'strategy',
  'brand-doc-section': targetOfHeading,
  'locale-file': 'localization',
  'license-file': targetOfLicensedFile,
  codeowners: 'governance',
  skipped: 'none',
};

export function targetFinding(finding: UntargetedFinding): Finding {
  const targetRule = TARGET_BY_KIND[finding.kind];
  const target = typeof targetRule === 'function' ? targetRule(finding) : targetRule;
  return { ...finding, target };
}
