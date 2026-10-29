#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_FILE_MAX_BYTES = 12288;
const SKILL_MARKDOWN_MAX_BYTES = 8192;
const DESCRIPTION_MIN_CHARACTERS = 200;
const DESCRIPTION_MAX_CHARACTERS = 520;
const NAME_MAX_CHARACTERS = 64;
const TOC_REQUIRED_ABOVE_LINES = 100;
const BUNDLED_PATH_PATTERN = /`((?:subskills|references|scripts|templates)\/[^`\s]+)`/g;
const MARKDOWN_LINK_PATTERN = /\]\(([^)\s#]+)(?:#[^)\s]*)?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const LINK_REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(\S+)/g;
const SCRIPT_EXTENSIONS = new Set([".ts", ".mjs", ".js", ".sh", ".py"]);
const PROHIBITION_PATTERN = /\b(never|do\s+not|don['\u2019]t|must\s+not|mustn['\u2019]t|should\s+not|shouldn['\u2019]t|avoid|avoids|avoiding)\b/gi;
const DATE_PATTERN = /\b(19|20)\d{2}-(0[1-9]|1[0-2])(-\d{2})?\b|\b(January|February|March|April|May|June|July|August|September|October|November|December) (19|20)\d{2}\b/g;
const SECTION_RANK = { input: 0, output: 1, step: 2, reference: 3, check: 4 };
const SPLIT_FIX = "Split the skill: move a phase into subskills/<phase>.md or reference material into references/<topic>.md, or hand part of the job to a separate skill.";

function violation(rule, line, message, fix, measure = 0) {
  return { rule, line, message, fix, measure };
}

export function maskInlineCode(line) {
  return line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
}

export function proseLines(markdown) {
  const lines = markdown.split("\n");
  const prose = [];
  let fenceMarker = null;
  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = lines[index].match(/^\s*(```|~~~)/);
    if (fenceMatch && !fenceMarker) {
      fenceMarker = fenceMatch[1];
      continue;
    }
    if (fenceMatch && fenceMatch[1] === fenceMarker) {
      fenceMarker = null;
      continue;
    }
    if (fenceMarker) continue;
    prose.push({ number: index + 1, text: maskInlineCode(lines[index]), rawText: lines[index] });
  }
  return prose;
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const bodyStartLine = match[0].split("\n").length - (match[0].endsWith("\n") ? 1 : 0);
  return { frontmatter: match[1], body: markdown.slice(match[0].length), bodyStartLine };
}

function readFrontmatterField(frontmatter, fieldName) {
  const lines = frontmatter.split("\n");
  const fieldIndex = lines.findIndex((line) => line.startsWith(`${fieldName}:`));
  if (fieldIndex < 0) return null;
  const inlineValue = lines[fieldIndex].slice(fieldName.length + 1).trim();
  const continuation = [];
  for (const line of lines.slice(fieldIndex + 1)) {
    if (!/^\s/.test(line)) break;
    continuation.push(line.trim());
  }
  const isBlockScalar = /^[>|][-+]?$/.test(inlineValue);
  const parts = isBlockScalar ? continuation : [inlineValue, ...continuation];
  return parts.join(" ").replace(/\s+/g, " ").trim().replace(/^(["'])(.*)\1$/, "$2");
}

function nameViolations(name, skillName) {
  if (!name) return [violation("name-missing", 1, "frontmatter has no name", "Add `name: <directory name>` to the frontmatter.")];
  const found = [];
  if (name !== skillName) found.push(violation("name-mismatch", 1, `name '${name}' differs from directory '${skillName}'`, "Set name to the skill directory name."));
  if (!/^[a-z0-9-]+$/.test(name) || name.length > NAME_MAX_CHARACTERS) {
    found.push(violation("name-format", 1, `name '${name}' is not 1-${NAME_MAX_CHARACTERS} lowercase letters, digits, and hyphens`, "Rename to lowercase letters, digits, and hyphens."));
  }
  const firstWord = name.split("-")[0];
  if (firstWord.length <= 4 || !firstWord.endsWith("ing")) found.push(violation("name-gerund", 1, `name '${name}' does not start with a gerund`, "Rename to a gerund phrase, verb first (processing-pdfs, reviewing-code)."));
  if (/anthropic|claude/.test(name)) found.push(violation("name-reserved", 1, `name '${name}' uses a reserved word`, "Drop 'anthropic' or 'claude' from the name."));
  return found;
}

function descriptionViolations(description) {
  if (!description) return [violation("description-missing", 1, "frontmatter has no description", "Add a description: what the skill does, then 'Use when ...'.")];
  const found = [];
  const length = description.length;
  if (length < DESCRIPTION_MIN_CHARACTERS) {
    found.push(violation("description-short", 1, `description is ${length} characters, under ${DESCRIPTION_MIN_CHARACTERS}`, "Say what the skill does and list the requests that should trigger it."));
  }
  if (length > DESCRIPTION_MAX_CHARACTERS) {
    found.push(violation("description-long", 1, `description is ${length} characters, over ${DESCRIPTION_MAX_CHARACTERS}`, `A description this long means the skill does too much. ${SPLIT_FIX} Otherwise move coverage lists into the body.`, length));
  }
  if (/[<>]/.test(description)) found.push(violation("description-markup", 1, "description contains angle brackets", "Remove XML or HTML from the description."));
  const firstWord = description.split(/\s+/)[0];
  if (!/^[A-Z][a-z]*[^s\W]s$|^(Does|Has|Is|Goes)$/.test(firstWord)) {
    found.push(violation("description-opening", 1, `description opens with '${firstWord}', not a third-person verb`, "Open with what the skill does, as a third-person verb: 'Reviews ...', 'Lands ...'."));
  }
  const unquoted = description.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, "");
  if (/\b(you|your|I)\b/.test(unquoted)) found.push(violation("description-person", 1, "description addresses the reader or speaks as 'I'", "Write in the third person: 'the carbon unit', 'the repo'."));
  if (!/\bUse (when|for)\b/.test(description)) found.push(violation("description-trigger", 1, "description has no 'Use when' or 'Use for' sentence", "Add a sentence starting 'Use when' or 'Use for' that lists the triggers."));
  return found;
}

function classifySection(title) {
  if (/^Input$/.test(title)) return "input";
  if (/^Output$/.test(title)) return "output";
  if (/^Check$/.test(title)) return "check";
  if (/^Step \d+: \S/.test(title)) return "step";
  return "reference";
}

function headings(prose) {
  return prose
    .map((line) => ({ number: line.number, match: line.text.match(/^(#{1,6})\s+(.*?)\s*$/) }))
    .filter((heading) => heading.match)
    .map((heading) => ({ number: heading.number, level: heading.match[1].length, title: heading.match[2] }));
}

function bodyViolations(body, bodyStartLine, isExtension) {
  const prose = proseLines(body).map((line) => ({ ...line, number: line.number + bodyStartLine }));
  const allHeadings = headings(prose);
  const found = [];
  const firstContent = prose.find((line) => line.text.trim());
  if (!firstContent || !/^# \S/.test(firstContent.text)) {
    found.push(violation("title-first", firstContent?.number ?? bodyStartLine, "body does not open with an H1 title", "Start the body with '# <Skill title>'."));
  }
  for (const heading of allHeadings.filter((heading) => heading.level === 1).slice(1)) {
    found.push(violation("title-single", heading.number, `second H1 '${heading.title}'`, "Keep one H1; make the rest H2 sections."));
  }
  for (const heading of allHeadings.filter((heading) => heading.level > 3)) {
    found.push(violation("heading-depth", heading.number, `H${heading.level} '${heading.title}'`, "Use at most H3; move deeper structure into lists or a subskill file."));
  }
  for (const heading of allHeadings.filter((heading) => /^(Step|Phase)\b/i.test(heading.title))) {
    if (heading.level === 2 && classifySection(heading.title) === "step") continue;
    found.push(violation("step-format", heading.number, `'${heading.title}' is not '## Step <n>: <title>'`, "Write each step as an H2 '## Step <n>: <title>'."));
  }
  const sections = allHeadings.filter((heading) => heading.level === 2).map((heading) => ({ ...heading, kind: classifySection(heading.title) }));
  let highestRank = -1;
  let highestTitle = "";
  for (const section of sections) {
    const rank = SECTION_RANK[section.kind];
    const isRepeatedSlot = rank === highestRank && ["input", "output", "check"].includes(section.kind);
    if (rank < highestRank || isRepeatedSlot) {
      found.push(violation("section-order", section.number, `'${section.title}' comes after '${highestTitle}'`, "Order H2 sections: Input, Output, Step 1..n, reference sections, Check."));
      continue;
    }
    highestRank = rank;
    highestTitle = section.title;
  }
  const stepNumbers = sections.filter((section) => section.kind === "step").map((section) => ({ ...section, value: Number(section.title.match(/^Step (\d+)/)[1]) }));
  stepNumbers.forEach((step, index) => {
    const isInSequence = isExtension ? index === 0 || step.value > stepNumbers[index - 1].value : step.value === index + 1;
    if (isInSequence) return;
    const expected = isExtension ? `a number above ${stepNumbers[index - 1].value}` : `Step ${index + 1}`;
    found.push(violation("step-sequence", step.number, `'${step.title}' should be ${expected}`, "Number steps 1..n with no gaps; an extension skill reuses its base skill's step numbers in increasing order."));
  });
  return found;
}

function phrasingViolations(markdown) {
  const found = [];
  for (const line of proseLines(markdown)) {
    for (const match of line.text.matchAll(PROHIBITION_PATTERN)) {
      const prohibitionKey = match[0].toLowerCase().replace(/\s+/g, " ").replace(/\u2019/g, "'");
      found.push(violation(`prohibition:${prohibitionKey}`, line.number, `prohibition '${match[0]}'`, "State the action to take instead of the one to skip."));
    }
    for (const match of line.text.matchAll(DATE_PATTERN)) {
      found.push(violation("dated-note", line.number, `date '${match[0]}'`, "Drop the date and incident history; git keeps it. Keep only the lesson."));
    }
  }
  return found;
}

function skillReferences(content) {
  const prose = proseLines(content);
  const targets = prose.flatMap((line) => [
    ...Array.from(line.text.matchAll(MARKDOWN_LINK_PATTERN)),
    ...Array.from(line.text.matchAll(LINK_REFERENCE_DEFINITION_PATTERN)),
    ...Array.from(line.rawText.matchAll(BUNDLED_PATH_PATTERN)),
  ].map((match) => ({ target: match[1], line: line.number })));
  const namedPaths = new Set(prose.flatMap((line) => line.rawText.match(/[\w./-]+\.md\b/g) ?? []));
  return { targets, namedPaths };
}

function linkViolations(filePath, content, skillDirectory, references = skillReferences(content)) {
  const found = [];
  for (const { target, line } of references.targets) {
    if (/^(?:[a-z][a-z\d+.-]*:|~|\/|#)/i.test(target)) continue;
    const relativeTarget = target.split("#")[0];
    const exists = [path.dirname(filePath), skillDirectory].some((directory) => fs.existsSync(path.resolve(directory, relativeTarget)));
    if (exists) continue;
    found.push(violation("link-broken", line, `relative target '${target}' does not exist`, "Link to a file beside this file or from the skill root."));
  }
  return found;
}

function skillPathViolations(content, skillNames) {
  return content.split("\n").flatMap((line, index) => Array.from(line.matchAll(/~\/(?:\.claude\/skills|\.dotfiles\/ai\/skills|\.dotfiles\/profiles\/[\w.-]+\/skills)\/([\w-]+(?:\.[\w-]+)*)/g))
    .filter((match) => !skillNames.has(match[1]))
    .map((match) => violation("skill-path-missing", index + 1, `path names no installed skill '${match[1]}'`, "Point the path at an existing skill directory.")));
}

function plainSkillReferenceViolations(content, skillName, skillNames, frontmatterLines) {
  const found = [];
  for (const line of proseLines(content)) {
    if (line.number <= frontmatterLines) continue;
    const textWithoutLinkTargets = line.text.replace(/\]\([^)]*\)/g, (target) => " ".repeat(target.length));
    for (const match of textWithoutLinkTargets.matchAll(/(?<![^\W_]_*|-_*)([a-z\d]+(?:-[a-z\d]+)+|[a-z\d]+(?=[*_]{0,3} skills?\b))(?!_*[^\W_]|_*-)/gi)) {
      const referencedName = match[1].toLowerCase();
      if (referencedName === skillName || !skillNames.has(referencedName)) continue;
      found.push(violation("skill-reference-plain", line.number, `skill '${referencedName}' named in plain text`, "Wrap the skill name in backticks."));
    }
  }
  return found;
}

function backslashPathViolations(content) {
  return proseLines(content).flatMap((line) => Array.from(line.text.matchAll(/\b[\w.-]+(?:\\(?![!-\/:-@[-`{-~])[\w.-]+)+/g))
    .map((match) => violation("path-backslash", line.number, `path '${match[0]}' uses backslashes`, "Use forward slashes in prose paths.")));
}

function tableOfContentsViolations(filePath, content) {
  if (path.basename(filePath) === "SKILL.md" || content.replace(/\n$/, "").split("\n").length <= TOC_REQUIRED_ABOVE_LINES) return [];
  const firstSection = headings(proseLines(content)).find((heading) => heading.level === 2);
  if (firstSection?.title === "Contents") return [];
  return [violation("toc-missing", firstSection?.number ?? 1, `markdown exceeds ${TOC_REQUIRED_ABOVE_LINES} lines without an opening '## Contents'`, "Add '## Contents' before the first other H2, linking to its sections.")];
}

function unreferencedFileViolations(skillDirectory, skillContent, references = skillReferences(skillContent)) {
  const bundledFiles = skillMarkdownFiles(skillDirectory).filter((file) => path.basename(file) !== "SKILL.md");
  const bundledCountByBasename = new Map();
  for (const file of bundledFiles) bundledCountByBasename.set(path.basename(file), (bundledCountByBasename.get(path.basename(file)) ?? 0) + 1);
  return bundledFiles
    .filter((file) => {
      const relativePath = path.relative(skillDirectory, file).split(path.sep).join("/");
      const isNamedByUniqueBasename = bundledCountByBasename.get(path.basename(file)) === 1 && references.namedPaths.has(path.basename(file));
      return !references.namedPaths.has(relativePath) && !references.namedPaths.has(`./${relativePath}`) && !isNamedByUniqueBasename;
    })
    .map((file) => violation("file-unreferenced", 1, `bundled markdown '${path.relative(skillDirectory, file)}' is absent from SKILL.md`, "Link or name the bundled file in SKILL.md."));
}

function shippedScripts(skillDirectory) {
  const scripts = [];
  for (const entry of safeReadDirectory(skillDirectory)) {
    if (entry.isFile() && isScriptFile(entry.name)) scripts.push(entry.name);
  }
  for (const entry of safeReadDirectory(path.join(skillDirectory, "scripts"))) {
    if (entry.isFile() && isScriptFile(entry.name)) scripts.push(`scripts/${entry.name}`);
  }
  return scripts.sort();
}

function isScriptFile(fileName) {
  if (/\.(test|spec)\.|\.d\.ts$/.test(fileName)) return false;
  return SCRIPT_EXTENSIONS.has(path.extname(fileName));
}

function safeReadDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function scriptViolations(body, bodyStartLine, skillDirectory) {
  const scripts = shippedScripts(skillDirectory);
  if (scripts.length === 0) return [];
  const lines = body.split("\n");
  const sectionStart = lines.findIndex((line) => /^## Scripts\s*$/.test(line));
  if (sectionStart < 0) {
    return [violation("scripts-section", bodyStartLine, `ships ${scripts.join(", ")} with no '## Scripts' section`, "Add '## Scripts' with one '- `<path>`: <what it is for>' line per script.")];
  }
  const sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^## /.test(line));
  const sectionLines = lines.slice(sectionStart + 1, sectionEnd < 0 ? lines.length : sectionEnd);
  const purposeByScript = new Map();
  for (const line of sectionLines) {
    const entry = line.match(/^- `([^`]+)`: (.+)$/);
    if (entry) purposeByScript.set(entry[1], entry[2].trim());
  }
  return scripts
    .filter((script) => (purposeByScript.get(script) ?? "").length < 12)
    .map((script) => violation(`script-purpose:${script}`, bodyStartLine + sectionStart + 1, `script '${script}' has no purpose line in '## Scripts'`, `Add '- \`${script}\`: <what it is for and when to run it>'.`));
}

function skillNamesIn(skillRoots) {
  return new Set(skillRoots.flatMap((root) => safeReadDirectory(root).filter((entry) => entry.isDirectory()).map((entry) => entry.name)));
}

function skillNamesBeside(skillDirectory) {
  const realDirectory = realPathOrSelf(skillDirectory);
  const repoRoot = findRepoRoot(realDirectory);
  return skillNamesIn(repoRoot ? defaultSkillRoots(repoRoot) : [path.dirname(realDirectory)]);
}

function skillNamesInstalledWith(skillDirectory) {
  const realDirectory = realPathOrSelf(skillDirectory);
  const repoRoot = findRepoRoot(realDirectory);
  if (!repoRoot) return skillNamesIn([path.dirname(realDirectory)]);
  const sharedSkillsRoot = path.join(repoRoot, "ai", "skills");
  const skillsRoot = path.dirname(realDirectory);
  const profileNames = skillsRoot === sharedSkillsRoot ? [] : profileLineage(repoRoot, path.basename(path.dirname(skillsRoot)));
  return skillNamesIn([sharedSkillsRoot, ...profileNames.map((profileName) => path.join(repoRoot, "profiles", profileName, "skills"))]);
}

function profileLineage(repoRoot, profileName, lineageSoFar = []) {
  if (lineageSoFar.includes(profileName)) return lineageSoFar;
  const lineage = [...lineageSoFar, profileName];
  const parentProfileName = readParentProfileName(repoRoot, profileName);
  if (!parentProfileName) return lineage;
  return profileLineage(repoRoot, parentProfileName, lineage);
}

function readParentProfileName(repoRoot, profileName) {
  try {
    const parentProfileName = JSON.parse(fs.readFileSync(path.join(repoRoot, "profiles", profileName, "ai.json"), "utf8")).extends;
    return typeof parentProfileName === "string" && /^[a-z0-9][a-z0-9-]*$/.test(parentProfileName) ? parentProfileName : null;
  } catch {
    return null;
  }
}

function isExtensionSkill(skillName, skillNames) {
  for (let separator = skillName.indexOf("-"); separator >= 0; separator = skillName.indexOf("-", separator + 1)) {
    if (skillNames.has(skillName.slice(0, separator))) return true;
  }
  return false;
}

export function lintSkillFile(filePath, rawContent) {
  const content = rawContent.replace(/\r\n/g, "\n");
  const skillDirectory = skillDirectoryOf(filePath);
  if (!skillDirectory) return [];
  const isSkillFile = path.basename(filePath) === "SKILL.md";
  const skillName = path.basename(skillDirectory);
  const skillNames = skillNamesBeside(skillDirectory);
  const parts = isSkillFile ? splitFrontmatter(content) : null;
  const sizeLimit = isSkillFile ? SKILL_FILE_MAX_BYTES : SKILL_MARKDOWN_MAX_BYTES;
  const size = Buffer.byteLength(rawContent, "utf8");
  const found = [];
  if (size > sizeLimit) found.push(violation("size", 1, `${size} bytes, cap ${sizeLimit}`, SPLIT_FIX, size));
  found.push(...phrasingViolations(content));
  const references = skillReferences(content);
  found.push(...linkViolations(filePath, content, skillDirectory, references));
  found.push(...skillPathViolations(content, skillNamesInstalledWith(skillDirectory)));
  found.push(...plainSkillReferenceViolations(content, skillName, skillNames, parts?.bodyStartLine ?? 0));
  found.push(...backslashPathViolations(content));
  found.push(...tableOfContentsViolations(filePath, content));
  if (!isSkillFile) return found;
  found.push(...unreferencedFileViolations(skillDirectory, content, references));
  if (!parts) return [...found, violation("frontmatter", 1, "SKILL.md has no frontmatter", "Open the file with '---', name, description, '---'.")];
  found.push(...nameViolations(readFrontmatterField(parts.frontmatter, "name"), skillName));
  found.push(...descriptionViolations(readFrontmatterField(parts.frontmatter, "description")));
  found.push(...bodyViolations(parts.body, parts.bodyStartLine, isExtensionSkill(skillName, skillNames)));
  found.push(...scriptViolations(parts.body, parts.bodyStartLine, skillDirectory));
  return found;
}

export function skillDirectoryOf(filePath) {
  const normalized = path.resolve(filePath);
  if (path.extname(normalized).toLowerCase() !== ".md") return null;
  const segments = normalized.split(path.sep);
  const skillsIndex = segments.lastIndexOf("skills", segments.length - 3);
  if (skillsIndex < 0) return null;
  const relativeSegments = segments.slice(skillsIndex + 2);
  if (relativeSegments.slice(0, -1).some((segment) => ["node_modules", "test"].includes(segment))) return null;
  const skillDirectory = segments.slice(0, skillsIndex + 2).join(path.sep);
  return isDotfilesSkillDirectory(skillDirectory) ? skillDirectory : null;
}

function realPathOfNearestAncestor(target) {
  const missingSegments = [];
  let existingAncestor = target;
  while (!fs.existsSync(existingAncestor) && existingAncestor !== path.dirname(existingAncestor)) {
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = path.dirname(existingAncestor);
  }
  return path.join(realPathOrSelf(existingAncestor), ...missingSegments);
}

function isDotfilesSkillDirectory(skillDirectory) {
  const realSkillsRoot = path.dirname(realPathOfNearestAncestor(skillDirectory));
  const repoRoot = findRepoRoot(realSkillsRoot);
  if (!repoRoot) return false;
  if (realSkillsRoot === path.join(repoRoot, "ai", "skills")) return true;
  return path.basename(realSkillsRoot) === "skills" && path.dirname(path.dirname(realSkillsRoot)) === path.join(repoRoot, "profiles");
}

function violationTotals(violations) {
  const totals = new Map();
  for (const found of violations) {
    const total = totals.get(found.rule) ?? { count: 0, measure: 0 };
    total.count++;
    total.measure = Math.max(total.measure, found.measure);
    totals.set(found.rule, total);
  }
  return totals;
}

function surplusViolations(priorOfRule, nextOfRule) {
  const unmatchedPrior = [...priorOfRule];
  const consumePriorMatch = (isMatch) => {
    const matchIndex = unmatchedPrior.findIndex(isMatch);
    if (matchIndex < 0) return false;
    unmatchedPrior.splice(matchIndex, 1);
    return true;
  };
  const unmatchedByPosition = nextOfRule.filter((found) => !consumePriorMatch((prior) => prior.line === found.line && prior.message === found.message));
  const surplus = unmatchedByPosition.filter((found) => !consumePriorMatch((prior) => prior.message === found.message));
  return surplus.length > 0 ? surplus : nextOfRule.slice(-1);
}

export function addedViolations(priorViolations, nextViolations) {
  const priorTotals = violationTotals(priorViolations);
  const nextTotals = violationTotals(nextViolations);
  const added = new Set();
  for (const [rule, next] of nextTotals) {
    const prior = priorTotals.get(rule) ?? { count: 0, measure: 0 };
    const hasGrown = next.count > prior.count || next.measure > prior.measure;
    if (!hasGrown) continue;
    const violationsOfRule = (violations) => violations.filter((found) => found.rule === rule);
    for (const found of surplusViolations(violationsOfRule(priorViolations), violationsOfRule(nextViolations))) added.add(found);
  }
  return nextViolations.filter((found) => added.has(found));
}

function realPathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function findRepoRoot(startDirectory) {
  for (let directory = startDirectory; directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, "ai", "skills")) && fs.existsSync(path.join(directory, "profiles"))) return directory;
  }
  return null;
}

function defaultSkillRoots(repoRoot) {
  const profileRoots = safeReadDirectory(path.join(repoRoot, "profiles"))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(repoRoot, "profiles", entry.name, "skills"))
    .filter((root) => fs.existsSync(root));
  return [path.join(repoRoot, "ai", "skills"), ...profileRoots];
}

function skillMarkdownFiles(skillDirectory) {
  const files = [];
  for (const entry of safeReadDirectory(skillDirectory)) {
    if (["node_modules", "test"].includes(entry.name)) continue;
    const entryPath = path.join(skillDirectory, entry.name);
    if (entry.isDirectory()) files.push(...skillMarkdownFiles(entryPath));
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") files.push(entryPath);
  }
  return files;
}

export function lintSkillDirectory(skillDirectory) {
  return skillMarkdownFiles(skillDirectory).flatMap((file) => lintSkillFile(file, fs.readFileSync(file, "utf8")).map((found) => ({ ...found, file })));
}

function runCommandLine(argumentList) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const skillDirectories = argumentList.length > 0
    ? argumentList.map((argument) => path.resolve(argument))
    : defaultSkillRoots(repoRoot).flatMap((root) => safeReadDirectory(root).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)));
  const violations = skillDirectories.filter((directory) => fs.existsSync(path.join(directory, "SKILL.md"))).flatMap(lintSkillDirectory);
  for (const found of violations) {
    console.log(`${path.relative(process.cwd(), found.file)}:${found.line}: ${found.rule.split(":")[0]}: ${found.message}. Fix: ${found.fix}`);
  }
  console.log(`${violations.length} violation(s) in ${skillDirectories.length} skill(s)`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}

const isRunDirectly = Boolean(process.argv[1]) && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isRunDirectly) runCommandLine(process.argv.slice(2));
