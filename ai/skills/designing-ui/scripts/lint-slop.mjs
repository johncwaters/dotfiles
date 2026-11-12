#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const UI_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".svelte", ".astro", ".mdx", ".erb", ".hbs", ".handlebars", ".mustache", ".php", ".njk", ".liquid", ".twig", ".jinja", ".jinja2", ".j2", ".ejs", ".pug", ".haml", ".slim", ".cshtml", ".razor", ".heex", ".eex", ".templ"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".astro", "coverage", "vendor"]);
const TAILWIND_SPACING_PROPERTIES = "(?:-?(?:m|mt|mb|ml|mr|mx|my|ms|me|p|pt|pb|pl|pr|px|py|ps|pe|top|bottom|left|right|inset|inset-x|inset-y|translate-x|translate-y)|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|min-h|max-w|max-h|size)";
const OFF_GRID_ARBITRARY_PX = new RegExp(`(?<![\\w-])${TAILWIND_SPACING_PROPERTIES}-\\[(\\d+(?:\\.\\d+)?)px\\]`, "g");
const TAILWIND_COLORED_SHADOW = /(?<![\w-])shadow-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const ZERO_OFFSET_SHADOW = /(?:box-shadow|text-shadow)\s*:\s*0(?:px)?\s+0(?:px)?\s+[1-9][^;]*|drop-shadow\(\s*0(?:px)?\s+0(?:px)?\s+[1-9][^)]*\)|shadow-\[0_0_[1-9][^\]]*\]/gi;
const CSS_RULE_BLOCK = /([^{};]*)\{([^{}]*)\}/g;
const HOVER_SCALE_DECLARATION = /transform\s*:\s*scale\(\s*1\.\d|(?<![\w-])scale\s*:\s*1\.\d/;
const PULSE_ANIMATION_DECLARATION = /animation(?:-name)?\s*:[^;}]*\b(?:pulse|ping|bounce)\b/;
const SHADOW_COLOR = /rgba?\(([^)]*)\)|#([0-9a-f]{3,8})\b|hsla?\(([^)]*)\)/i;

const PATTERN_RULES = [
  { rule: "transition-all", pattern: /(?<![\w-])transition-all\b|transition\s*:\s*all\b/ },
  { rule: "hover-scale", pattern: /(?<![\w-])(?:group-)?hover:scale-\d|:hover\s*\{[^}]*transform\s*:\s*scale\(\s*1\.\d/ },
  { rule: "looping-pulse", pattern: /(?<![\w-])animate-(?:(?:pulse|ping|bounce)\b|\[(?:pulse|ping|bounce)[_\]])|animation\s*:(?=[^;]*\binfinite\b)[^;]*\b(?:pulse|ping|bounce)\b/ },
  { rule: "gradient-text", pattern: /(?<![\w-])bg-clip-text\b|(?:-webkit-)?background-clip\s*:\s*text\b/ },
  { rule: "heavy-weight", pattern: /font-weight\s*:\s*(?:800|900|extrabold|black)\b|(?<![\w-])font-(?:extrabold|black)\b/ },
  { rule: "emoji", pattern: /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u },
];

function isNeutralColor(colorMatch) {
  const [, rgbArguments, hexDigits, hslArguments] = colorMatch;
  if (hslArguments) return /^\s*[\d.]+(?:deg)?[\s,]+0%/.test(hslArguments);
  if (rgbArguments) {
    const [red, green, blue] = rgbArguments.split(/[\s,/]+/).filter(Boolean).map(Number);
    return red === green && green === blue;
  }
  const fullHex = hexDigits.length <= 4 ? [...hexDigits].map((digit) => digit + digit).join("") : hexDigits;
  return fullHex.slice(0, 2) === fullHex.slice(2, 4) && fullHex.slice(2, 4) === fullHex.slice(4, 6);
}

function isColoredShadow(shadowText) {
  const colorMatch = shadowText.match(SHADOW_COLOR);
  return Boolean(colorMatch) && !isNeutralColor(colorMatch);
}

function hasColoredGlow(lineText) {
  if (TAILWIND_COLORED_SHADOW.test(lineText)) return true;
  return [...lineText.matchAll(ZERO_OFFSET_SHADOW)].some((shadow) => isColoredShadow(shadow[0]));
}

function cssRuleBlockFlags(source, lineNumberAt) {
  const flags = [];
  for (const block of source.matchAll(CSS_RULE_BLOCK)) {
    const [, selector, body] = block;
    const bodyOffset = block.index + selector.length + 1;
    const hoverScale = /:hover\b/.test(selector) && body.match(HOVER_SCALE_DECLARATION);
    if (hoverScale) flags.push({ line: lineNumberAt(bodyOffset + hoverScale.index), rule: "hover-scale" });
    const pulseAnimation = /\binfinite\b/.test(body) && body.match(PULSE_ANIMATION_DECLARATION);
    if (pulseAnimation) flags.push({ line: lineNumberAt(bodyOffset + pulseAnimation.index), rule: "looping-pulse" });
    for (const shadow of body.matchAll(ZERO_OFFSET_SHADOW)) {
      if (isColoredShadow(shadow[0])) flags.push({ line: lineNumberAt(bodyOffset + shadow.index), rule: "colored-glow" });
    }
  }
  return flags;
}

function hasOffGridSpacing(lineText) {
  return [...lineText.matchAll(OFF_GRID_ARBITRARY_PX)].map((match) => Number(match[1])).some((pixels) => pixels > 2 && pixels % 4 !== 0);
}

function lintSlop(rawSource) {
  const source = rawSource.replace(/\r\n/g, "\n");
  const sourceLines = source.split("\n");
  const lineNumberAt = (offset) => source.slice(0, offset).split("\n").length;
  const flags = [];
  sourceLines.forEach((lineText, lineIndex) => {
    const line = lineIndex + 1;
    for (const { rule, pattern } of PATTERN_RULES) {
      if (pattern.test(lineText)) flags.push({ line, rule });
    }
    if (hasColoredGlow(lineText)) flags.push({ line, rule: "colored-glow" });
    if (hasOffGridSpacing(lineText)) flags.push({ line, rule: "off-grid-px" });
  });
  const flagsByLineAndRule = new Map([...flags, ...cssRuleBlockFlags(source, lineNumberAt)].map((flag) => [`${flag.line}:${flag.rule}`, flag]));
  return [...flagsByLineAndRule.values()].sort((first, second) => first.line - second.line).map((flag) => ({ ...flag, text: sourceLines[flag.line - 1].trim() }));
}

function uiSourceFiles(targetPath) {
  if (!fs.statSync(targetPath).isDirectory()) return [targetPath];
  return fs.readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : uiSourceFiles(entryPath);
    return UI_SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function runCommandLine(targetPaths) {
  if (targetPaths.length === 0) {
    console.error("usage: lint-slop.mjs <file-or-directory>...");
    process.exitCode = 2;
    return;
  }
  const scannedFiles = targetPaths.flatMap(uiSourceFiles);
  if (scannedFiles.length === 0) {
    console.error(`no UI source files found under ${targetPaths.join(", ")}; pass the UI files directly`);
    process.exitCode = 2;
    return;
  }
  const flags = scannedFiles.flatMap((filePath) => lintSlop(fs.readFileSync(filePath, "utf8")).map((flag) => ({ ...flag, filePath })));
  for (const flag of flags) console.log(`${flag.filePath}:${flag.line}: ${flag.rule}: ${flag.text.slice(0, 160)}`);
  console.log(`${flags.length} flag(s) in ${scannedFiles.length} file(s). Fix each, or keep it where the resolved taste names that rule as an override, and rerun.`);
  process.exitCode = flags.length > 0 ? 1 : 0;
}

const isRunDirectly = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isRunDirectly) runCommandLine(process.argv.slice(2));
