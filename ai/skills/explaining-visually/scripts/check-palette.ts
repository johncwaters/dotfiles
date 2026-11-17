import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scanFile } from '../../auditing-brand/census.ts';

type Role = { boardTone: string | null; boardIcon: string; hex: string };
type VisualLanguage = { roles: Record<string, Role>; fonts: string[] };

const visualLanguage: VisualLanguage = JSON.parse(readFileSync(new URL('../visual-language.json', import.meta.url), 'utf8'));
const templateText = readFileSync(new URL('../../drawing-whiteboards/template.html', import.meta.url), 'utf8');

export function allowedColorsOf(templateSource: string, roles: Record<string, Role>): Set<string> {
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(templateSource)?.[1] ?? '';
  const templateHexes = [...rootBlock.matchAll(/--[\w-]+\s*:\s*(#[0-9a-f]{3,8})/gi)].map((match) => match[1].toLowerCase());
  const roleHexes = Object.values(roles).map((role) => role.hex.toLowerCase());
  return new Set([...templateHexes, ...roleHexes]);
}

const colorValuesThatAreNotColors = new Set(['none', 'currentcolor', 'transparent', 'inherit']);

export function namedColorsIn(svgText: string): string[] {
  const colorValues = [...svgText.matchAll(/(?:^|[\s;"'{])(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?([a-z]+)\b/gi)].map((match) => match[1].toLowerCase());
  return colorValues.filter((colorValue) => !colorValuesThatAreNotColors.has(colorValue) && colorValue !== 'url' && colorValue !== 'rgb' && colorValue !== 'hsl');
}

export async function paletteViolations(file: string, allowedColors: Set<string>, allowedFonts: Set<string>): Promise<string[]> {
  const findings = await scanFile(path.dirname(file), path.basename(file), { tailwindTextNames: new Set(), deferredTailwindText: [] });
  const skippedFinding = findings.find((finding) => finding.kind === 'skipped');
  if (skippedFinding) {
    return [`${file}: not scanned (${skippedFinding.normalized})`];
  }
  const violations = namedColorsIn(readFileSync(file, 'utf8')).map((namedColor) => `${file}: color ${namedColor} is off-palette`);
  for (const finding of findings) {
    if (finding.kind === 'color' && !allowedColors.has(finding.normalized)) {
      violations.push(`${file}: color ${finding.normalized} is off-palette`);
    }
    if (finding.kind !== 'font-family') {
      continue;
    }
    for (const family of finding.normalized.split(',').map((part) => part.trim())) {
      if (!allowedFonts.has(family)) {
        violations.push(`${file}: font ${family} is off-palette`);
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('usage: node check-palette.ts <file.svg>...\n');
    process.exit(2);
  }
  const allowedColors = allowedColorsOf(templateText, visualLanguage.roles);
  const allowedFonts = new Set(visualLanguage.fonts);
  const violations = (await Promise.all(files.map((file) => paletteViolations(file, allowedColors, allowedFonts)))).flat();
  for (const violation of violations) {
    process.stdout.write(`${violation}\n`);
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
