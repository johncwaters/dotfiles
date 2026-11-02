#!/usr/bin/env node
import fs from "node:fs";
import { proseLines } from "../../../hooks/skill-lint.mjs";

const SUBORDINATE_OPENERS = new Set(["if", "when", "because", "since", "while", "although", "though", "once", "after", "before", "unless", "until", "whenever"]);
const PREPOSITIONAL_OPENERS = new Set(["in", "for", "to", "on", "at", "from", "without", "instead", "during", "with"]);
const SUBJECT_PRONOUN = /\b(?:i|you|we|they|he|she|it)\b/i;
const AFFIRMATION_OPENERS = new Set(["yeh", "yah", "yeah", "yep", "yes", "ok", "okay", "sure", "true", "gotcha", "right", "oh", "ah", "for sure", "right on"]);
const SPLICE_AFTER_COMMA = /,\s+(?:(?:i|you|we|they|it|that|this|these|those|he|she|there)(?:['\u2019](?:s|re|ll|ve|d|m))?\s+(?!and\b|or\b)[a-z']+|(?:the|my|your|our|their)\s+[a-z][\w-]*)/i;
const LIST_CONTINUATION = /,\s+(?:and|or)\s/i;
const NOT_X_ITS_Y = /\b(?:it|this|that)(?:['’]s|\s+is)\s+not\b[^.!?]*?[,;]\s*(?:it|this|that)(?:['’]s|\s+is)\b/gi;

const SHARED_PATTERN_RULES = [
  { rule: "filler-word", pattern: /\b(?:just|basically|finally)\b/i },
  { rule: "em-dash", pattern: /—/ },
  { rule: "machine-tell", pattern: /\b(?:delv(?:e|es|ed|ing)|tapestry|landscape|game-changer|unlock(?:s|ed|ing)?|navigate the complexities|in today['’]s world|have you ever wondered|here are (?:\d+|two|three|four|five|six|seven|eight|nine|ten) )|^\s*(?:in conclusion|ultimately)\b/i },
  { rule: "corporate-opener", pattern: /\bhope this (?:email|message|note) finds you well\b|\bfriendly reminder\b/i },
  { rule: "teaser", pattern: /\b(?:(?:shows|explains) why|here['’]s (?:why|how|the thing))\s*[.!?:]*\s*$/i },
  { rule: "corporate-closer", pattern: /^\s*(?:best|cheers|regards|best regards|kind regards|warm regards|warmly|sincerely|all the best)\s*[,.!]?\s*$/i },
];

const LONGFORM_PATTERN_RULES = [
  { rule: "vague-quantity", pattern: /\b(?:a lot|soon|quickly|better)\b/i },
  { rule: "emoji-bullet", pattern: /^\s*(?:[-*+]\s+)?\p{Extended_Pictographic}/u },
  { rule: "british-form", pattern: /\b(?:mustn['’]t|shan['’]t|whilst|amongst)\b/i },
  { rule: "hedge", pattern: /\bpretty (?:good|average|much)\b/i },
  { rule: "volatile-number", pattern: /^(?=.*\]\(\/docs)(?=.*\b\d+\s*(?:days?|seconds?|minutes?|hours?|requests?)\b)/i },
];


function sentencesOf(text) {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function openingWordOf(clause) {
  const [firstWord = "", secondWord = ""] = clause.toLowerCase().match(/[a-z]+/g) ?? [];
  return firstWord === "right" && SUBORDINATE_OPENERS.has(secondWord) ? secondWord : firstWord;
}

function isIntroductoryPhrase(clause) {
  const openingWord = openingWordOf(clause);
  if (SUBORDINATE_OPENERS.has(openingWord)) return true;
  return PREPOSITIONAL_OPENERS.has(openingWord) && !SUBJECT_PRONOUN.test(clause);
}

function isCommaSplice(sentence) {
  const splice = sentence.match(SPLICE_AFTER_COMMA);
  if (!splice) return false;
  const clauseBeforeComma = sentence.slice(0, splice.index).trim();
  const openerAfterLabel = clauseBeforeComma.split(/:\**\s|\s-\s/).pop().trim();
  if (SUBORDINATE_OPENERS.has(openingWordOf(sentence))) return false;
  if (AFFIRMATION_OPENERS.has(openerAfterLabel.toLowerCase())) return true;
  if (isIntroductoryPhrase(openerAfterLabel)) return false;
  if (!/\s/.test(openerAfterLabel)) return false;
  return !LIST_CONTINUATION.test(sentence.slice(splice.index + splice[0].length));
}

function draftLines(draft) {
  return proseLines(draft).filter((line) => !/^\s*>/.test(line.rawText) && line.text.trim().length > 0);
}

function headingSectionFlags(draft) {
  const rawLines = draft.split("\n");
  const proseByNumber = new Map(proseLines(draft).map((line) => [line.number, line]));
  const headingNumbers = [...proseByNumber.values()].filter((line) => /^#{1,6}\s/.test(line.text)).map((line) => line.number);
  const flags = [];
  headingNumbers.forEach((headingNumber, headingIndex) => {
    const sectionEnd = headingNumbers[headingIndex + 1] ?? rawLines.length + 1;
    const sectionNumbers = [];
    for (let number = headingNumber + 1; number < sectionEnd; number++) {
      if (rawLines[number - 1].trim()) sectionNumbers.push(number);
    }
    const isAllProse = sectionNumbers.every((number) => proseByNumber.has(number));
    const isPlainParagraph = sectionNumbers.length === 1 && !/^\s*(?:[-*+|]|\d+\.)\s/.test(rawLines[sectionNumbers[0] - 1]);
    if (!isAllProse || !isPlainParagraph) return;
    if (sentencesOf(proseByNumber.get(sectionNumbers[0]).text).length !== 1) return;
    flags.push({ line: headingNumber, rule: "one-sentence-heading", text: rawLines[headingNumber - 1].trim() });
  });
  return flags;
}

function repeatedContrastFlags(lines) {
  const flags = [];
  let contrastCount = 0;
  for (const line of lines) {
    for (const contrast of line.text.matchAll(NOT_X_ITS_Y)) {
      contrastCount += 1;
      if (contrastCount > 1) flags.push({ line: line.number, rule: "repeated-not-x-its-y", text: contrast[0] });
    }
  }
  return flags;
}

function mixedApostropheFlags(lines) {
  const hasStraight = lines.some((line) => /[a-z]'[a-z]/i.test(line.text));
  const firstCurlyLine = lines.find((line) => /[a-z]’[a-z]/i.test(line.text));
  if (!hasStraight || !firstCurlyLine) return [];
  return [{ line: firstCurlyLine.number, rule: "mixed-apostrophes", text: firstCurlyLine.text.trim() }];
}

function lintDraft(rawDraft, { isLongform = false } = {}) {
  const draft = rawDraft.replace(/\r\n/g, "\n");
  const lines = draftLines(draft);
  const patternRules = isLongform ? [...SHARED_PATTERN_RULES, ...LONGFORM_PATTERN_RULES] : SHARED_PATTERN_RULES;
  const flags = [];
  for (const line of lines) {
    for (const sentence of sentencesOf(line.text)) {
      const brokenRules = patternRules.filter(({ pattern }) => pattern.test(sentence)).map(({ rule }) => rule);
      if (isCommaSplice(sentence)) brokenRules.push("comma-splice");
      for (const rule of brokenRules) flags.push({ line: line.number, rule, text: sentence });
    }
  }
  if (!isLongform) return flags;
  return [...flags, ...repeatedContrastFlags(lines), ...headingSectionFlags(draft), ...mixedApostropheFlags(lines)].sort((first, second) => first.line - second.line);
}

function runCommandLine(argumentList) {
  const isLongform = argumentList.includes("--longform");
  const draftPaths = argumentList.filter((argument) => argument !== "--longform");
  const draftSources = draftPaths.length > 0 ? draftPaths : [0];
  const flags = draftSources.flatMap((source) => lintDraft(fs.readFileSync(source, "utf8"), { isLongform }).map((flag) => ({ ...flag, source })));
  for (const flag of flags) console.log(`${draftPaths.length > 1 ? `${flag.source}:` : ""}${flag.line}: ${flag.rule}: ${flag.text}`);
  if (flags.some((flag) => flag.rule === "comma-splice")) console.log("comma-splice: delete the whole sentence. A spliced line is usually a fluff acknowledgement, and splitting it with a period or joining it with 'and' keeps the fluff. Rewrite it only when it carries a fact the reader needs.");
  if (flags.some((flag) => flag.rule === "teaser")) console.log("teaser: delete the whole sentence. It announces a reason without giving one, so open the next sentence with the reason itself.");
  console.log(`${flags.length} flag(s). Delete or rewrite each flagged sentence and rerun until 0.`);
  process.exitCode = flags.length > 0 ? 1 : 0;
}

const isRunDirectly = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isRunDirectly) runCommandLine(process.argv.slice(2));
