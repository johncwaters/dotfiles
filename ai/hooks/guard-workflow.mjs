#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { allow, COMMAND_START, COMMAND_WRAPPERS, denyPreToolUse, isAttendedMainLoopCall, nearestExistingDirectory, readPayload } from "./hook-io.mjs";
import { isSkillRun, sessionEvents } from "./session-transcript.mjs";
import { NO_UPSTREAM } from "../skills/specifying/lib/graph.ts";
import { specsDirectory } from "../skills/specifying/lib/spec-store.ts";

v8.setFlagsFromString("--enable-experimental-regexp-engine");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SPEC_GATE_MARKER = "[spec-gate]";
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
const GIT_ALIAS_TO_COMMIT_OR_PUSH = String.raw`-c\s*(?:alias\.[^=\s]+=\S*|"alias\.[^"=]+=[^"]*|'alias\.[^'=]+=[^']*)\b(?:commit|push)\b`;
const GIT_COMMIT_OR_PUSH = new RegExp(
  String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?git['"]?${GIT_GLOBAL_OPTIONS}\s+(?:(?:commit|push)(?=\s|$|[;&|)'"])|${GIT_ALIAS_TO_COMMIT_OR_PUSH})`,
  "m",
);
const LANDING_SKILLS = ["landing", "opening-prs"];
const UPSTREAM_LINE = /^\s*Upstream:[ \t]*(.*)$/gm;
const CHANGE_AT_SOURCE_LABEL = /\(change at the source\)/i;
const SKILLS_ENDING_SPECIFYING = [...LANDING_SKILLS, "gating-reviews", "converging-reviews", "reviewing-prs"];
const RULED_OUT_BY = /\S.*,\s*ruled out by\s+\S/i;
const INTERPRETER_EVAL_FLAG = String.raw`\b(?:(?:node|nodejs|bun|deno)(?:\s+-\S+)*\s+(?:-[ep]|--eval|--print)|(?:perl|ruby)(?:\s+-\S+)*\s+-\w*[eE]|php(?:\s+-\S+)*\s+-r|osascript(?:\s+-\S+)*\s+-e)`;
const SHELL_EVALUATES_NEXT_WORD = new RegExp(String.raw`(?:\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c|\beval|\s-c|${INTERPRETER_EVAL_FLAG})\s*$`);
const SHELL_WORD_ON_LINE = /(?:^|[;&|(\s])(?:\S*\/)?(?:(?:ba|z|da|k)?sh|eval)(?=$|[\s;&|)])/;
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*\n)([\s\S]*?\n)?([ \t]*\2[ \t]*(?=\n|$))/g;
const PATTERN_KILL_CALL = new RegExp(String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}(?:\S*/)?(pkill|pgrep)((?:\s+(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|)\x60'"\\])+)*)`, "gm");
const KILL_COMMAND_WORD = /(?:^|[\s;&|({\x60])(?:\S*\/)?kill(?=$|[\s;&|)\x60])/m;
const PKILL_FULL_FLAG = /^(?:--full|-[A-Za-z]*f[A-Za-z]*)$/;
const CASE_INSENSITIVE_OPTION = /^(?:--ignore-case|-[A-Za-z]*i[A-Za-z]*)$/;
const SIGNAL_OPTION = /^-(?:\d+|[A-Z][A-Z0-9+-]+)$/;
const VALUE_TAKING_SHORT_OPTIONS = new Set("dgGPstuUFr");
const VALUE_TAKING_LONG_OPTION = /^--(?:delimiter|signal|group|pgroup|parent|session|terminal|euid|uid|pidfile|runstates|ns|nslist|cgroup|env)$/;
const QUOTE_AWARE_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"])+/g;
const SHELL_WORD_PART = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)|([^'"\\]+)/gs;
const SINGLE_QUOTED_LITERAL = /(?<![$\\])'[^']*'/g;
const REDIRECTION_OPERATOR_WORD = /^(?:\d*|&)[<>][<>&|]*$/;
const REDIRECTION_WORD = /^(?:\d*|&)[<>]/;
const SHELL_EXPANSION = /\$[\w{('"]|\x60/;
const BRACKET_CLASS = /\[[^\]]+\]/;
const POSIX_CHARACTER_CLASS = /\[:([a-z]+):\]/y;
const JAVASCRIPT_RANGE_BY_POSIX_CLASS = new Map([
  ["alpha", "a-zA-Z"],
  ["digit", "0-9"],
  ["alnum", "a-zA-Z0-9"],
  ["upper", "A-Z"],
  ["lower", "a-z"],
  ["space", "\\s"],
  ["blank", " \\t"],
  ["xdigit", "0-9A-Fa-f"],
  ["punct", "!-\\/:-@\\[-`{-~"],
  ["cntrl", "\\x00-\\x1f\\x7f"],
  ["print", "\\x20-\\x7e"],
  ["graph", "\\x21-\\x7e"],
]);
const JAVASCRIPT_ESCAPE_BY_ERE_ESCAPE = new Map([
  ["<", "\\b"],
  [">", "\\b"],
  ["w", "\\w"],
  ["W", "\\W"],
  ["s", "\\s"],
  ["S", "\\S"],
  ["b", "\\b"],
  ["B", "\\B"],
]);
const ERE_LITERAL_ESCAPES = new Set(".[]{}()*+?^$|\\/");
const OUTPUT_REDIRECT = /(?:^|[^<>&\d=-])(?:\d|&)?>>?(?![&>(=])[ \t]*([^\s;&|()<>]*)/g;
const FILE_WRITING_COMMAND = new RegExp(String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}(?:\S*/)?(tee|sed|perl|ruby|patch|git${GIT_GLOBAL_OPTIONS}\s+apply)(?=\s|$)([^;&|\n]*)`, "gm");
const FIND_EXEC_EDIT = /-(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?(sed|perl|ruby)(?=\s)([^;&|\n]*)/g;
const DIRECTORY_CHANGE = /(?:^|[;&|(\n])\s*(?:cd|pushd)\s+([^\s;&|)]+)/g;
const VARIABLE_REFERENCE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
const PLAIN_ASSIGNMENT = /^(?:export\s+)?([A-Za-z_]\w*)=((?:'[^']*'|"[^"\\`$]*(?:\$\{?[A-Za-z_]\w*\}?[^"\\`$]*)*"|[^\s'"\\`])*)$/;
const CONDITIONAL_OR_SUBSHELL_CODE = /(?:^|[\s;&|])(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function|\{|\}|#\S*)(?=$|[\s;&|])|(?<!\$)\(|`|\bcoproc\b/;
const STATEMENT_SEPARATOR = /^(?:&&|\|\||;;|[;\n|&])/;
const SHELL_RUNS_NEXT_WORD = /(?:\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c|\beval)\s*$/;
const IN_PLACE_FLAG = /^(?:-[A-Za-z0-9]*i|--in-place)/;
const SCRIPT_TAKING_FLAG = /^(?:--expression|-f|--file)$/;
const ATTACHED_SCRIPT_FLAG = /^(?:--(?:expression|file)=|-e.)/;
const INLINE_SCRIPT_FLAG = /^-[A-Za-z0-9]*e$/;
const UNRESOLVABLE_PATH_CHARACTERS = /[$`*?[{]/;
const UNRESOLVED_TARGET_NAME = "unresolved-write-target";

const RAW_COMMIT_REASON =
  "Raw `git commit` and `git push` are denied outside /landing, so every landing commits a tree a review gate stamped. " +
  "Run the review gate (the intent's gate, else /gating-reviews), then /landing, which also commits without pushing (land.ts --no-push) when asked; /gating-reviews stamps a pure rename or a reviewer's suggestion applied verbatim without a review pass. " +
  "Never commit a WIP set-aside to integrate mainline: uncommitted work proceeds behind mainline, land.ts --promote rebases the landed commit onto it, and a conflict there resolves through landing recovery. " +
  "Commits already made (a mainline sync's merge) push through /landing's land.ts with no message, which withholds any commit no review recorded. " +
  "A carbon unit who wants a raw commit runs it themselves with `! git ...`.";

function upstreamQuestionReason(unweighedHeaders) {
  return (
    `A /specifying question round must weigh a change at the source, and these questions do not: ${unweighedHeaders.join(", ")}. ` +
    "Give each one an option whose label carries `(change at the source)` when one is workable, else an `Upstream: <alternative>, ruled out by <evidence>` line in the question, else an `Upstream: none: <reason>` line when nothing sits above the choice (ai/skills/specifying/subskills/ask.md step 1)."
  );
}

const KILL_SELF_MATCH_REASON =
  "A kill by pattern (pkill -f, or pgrep -f feeding kill) matches full command lines, and this pattern matches text in this same Bash call, which its own shell carries, so the call kills itself. " +
  "Run the kill in its own Bash call with one character of the pattern bracketed ('[n]ode server'), so the pattern no longer matches its own text.";

const SPEC_GATE_REASON =
  `${SPEC_GATE_MARKER} This is the first repo edit in a session that never ran /specifying. ` +
  "Any change that involves a choice goes through /specifying first: a feature, a behavior change, a refactor, a new skill, hook, agent, or config, a non-trivial bug fix, or a multi-file change. Run /specifying now. " +
  "Retry this same edit only for a typo or mechanical edit with no decision in it, an edit the carbon unit dictated verbatim, or when the carbon unit said to skip /specifying; \"small\" or \"obvious\" is not an exemption. The gate fires once per session.";

async function hasLandingSkillRunSinceLastPrompt(transcriptPath) {
  let hasLandingSkillRun = false;
  for await (const event of sessionEvents(transcriptPath)) {
    if (event.kind === "prompt") hasLandingSkillRun = false;
    if (LANDING_SKILLS.some((skillName) => isSkillRun(event, skillName))) hasLandingSkillRun = true;
  }
  return hasLandingSkillRun;
}

async function isSpecifyingUnfinished(transcriptPath) {
  let isUnfinished = false;
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, "specifying")) isUnfinished = true;
    if (SKILLS_ENDING_SPECIFYING.some((skillName) => isSkillRun(event, skillName))) isUnfinished = false;
  }
  return isUnfinished;
}

function isWeighedUpstream(upstreamText) {
  const upstream = upstreamText.trim();
  if (/^none\b/i.test(upstream)) return NO_UPSTREAM.test(upstream);
  return RULED_OUT_BY.test(upstream);
}

function questionWeighsUpstream(question) {
  if (!question || typeof question !== "object") return false;
  const questionText = String(question.question || "");
  if ([...questionText.matchAll(UPSTREAM_LINE)].some((match) => isWeighedUpstream(match[1]))) return true;
  const options = Array.isArray(question.options) ? question.options : [];
  return options.some((option) => CHANGE_AT_SOURCE_LABEL.test(String(option?.label || "")));
}

async function guardUpstreamQuestions(toolInput, transcriptPath) {
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const unweighedHeaders = questions.filter((question) => !questionWeighsUpstream(question)).map((question) => String(question?.header || question?.question || "a question"));
  if (unweighedHeaders.length === 0) return;
  if (!(await isSpecifyingUnfinished(transcriptPath))) return;
  denyPreToolUse(upstreamQuestionReason(unweighedHeaders));
}

function isInsideDirectory(filePath, directory) {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSpecGateDenial(event) {
  return event.kind === "toolResult" && event.isError && event.text.startsWith("PreToolUse:") && event.text.includes(SPEC_GATE_MARKER);
}

async function hasSpecGateCleared(transcriptPath, specsDirectory) {
  for await (const event of sessionEvents(transcriptPath)) {
    if (["specifying", "gating-reviews", "converging-reviews"].some((skillName) => isSkillRun(event, skillName))) return true;
    if (isSpecGateDenial(event)) return true;
    if (event.kind !== "toolUse" || event.name !== "Read") continue;
    const readPath = String(event.input.file_path || "");
    if (path.isAbsolute(readPath) && isInsideDirectory(readPath, specsDirectory)) return true;
  }
  return false;
}

function isInsideGitWorktree(filePath) {
  const gitProbe = spawnSync("git", ["-C", nearestExistingDirectory(filePath), "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return gitProbe.status === 0 && gitProbe.stdout.trim() === "true";
}

function maskLiteralHeredocBodies(command) {
  return command.replace(HEREDOC, (heredoc, quote, delimiter, header, body = "", terminator, offset) => {
    const textBeforeHeredoc = command.slice(command.lastIndexOf("\n", offset) + 1, offset);
    const isShellInput = SHELL_WORD_ON_LINE.test(`${textBeforeHeredoc} ${header}`);
    const canExpandCommands = quote === "" && /\$\(|`/.test(body);
    if (isShellInput || canExpandCommands) return heredoc;
    return `<<${quote}${delimiter}${quote}${header}${terminator}`;
  });
}

function maskSingleQuotedText(command) {
  let maskedCommand = "";
  let index = 0;
  let isInsideDoubleQuotes = false;
  while (index < command.length) {
    const character = command[index];
    if (character === "\\") {
      maskedCommand += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') isInsideDoubleQuotes = !isInsideDoubleQuotes;
    if (character !== "'" || isInsideDoubleQuotes) {
      maskedCommand += character;
      index += 1;
      continue;
    }
    const closingIndex = command.indexOf("'", index + 1);
    if (closingIndex === -1) return maskedCommand + command.slice(index);
    const quotedText = command.slice(index, closingIndex + 1);
    const isEvaluatedByShell = SHELL_EVALUATES_NEXT_WORD.test(maskedCommand);
    maskedCommand += isEvaluatedByShell || !/\s/.test(quotedText) ? quotedText : "''";
    index = closingIndex + 1;
  }
  return maskedCommand;
}

function optionTakesNextWord(optionWord) {
  if (SIGNAL_OPTION.test(optionWord)) return false;
  if (optionWord.startsWith("--")) return VALUE_TAKING_LONG_OPTION.test(optionWord);
  const optionLetters = [...optionWord.slice(1)];
  return optionLetters.findIndex((letter) => VALUE_TAKING_SHORT_OPTIONS.has(letter)) === optionLetters.length - 1;
}

function patternKillArguments(argumentText) {
  const words = argumentText.match(QUOTE_AWARE_WORD) ?? [];
  const optionWords = [];
  const operandWords = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (REDIRECTION_OPERATOR_WORD.test(word)) {
      index += 1;
      continue;
    }
    if (REDIRECTION_WORD.test(word)) continue;
    if (!word.startsWith("-") || word === "-") {
      operandWords.push(word);
      continue;
    }
    optionWords.push(word);
    if (optionTakesNextWord(word)) index += 1;
  }
  return { optionWords, patternWord: operandWords[0] ?? "" };
}

function unquotedShellWord(word) {
  return [...word.matchAll(SHELL_WORD_PART)]
    .map(([, singleQuoted, doubleQuoted, escapedCharacter, bareText]) => singleQuoted ?? doubleQuoted?.replace(/\\([$`"\\\n])/g, "$1") ?? escapedCharacter ?? bareText)
    .join("");
}

function javascriptBracketExpression(erePattern, openingIndex, foldCase) {
  let index = openingIndex + 1;
  let javascriptClass = "[";
  if (erePattern[index] === "^") {
    javascriptClass += "^";
    index += 1;
  }
  if (erePattern[index] === "]") {
    javascriptClass += "\\]";
    index += 1;
  }
  while (index < erePattern.length && erePattern[index] !== "]") {
    POSIX_CHARACTER_CLASS.lastIndex = index;
    const posixClass = POSIX_CHARACTER_CLASS.exec(erePattern);
    if (posixClass !== null) {
      const javascriptRange = JAVASCRIPT_RANGE_BY_POSIX_CLASS.get(posixClass[1]);
      if (javascriptRange === undefined) return null;
      javascriptClass += foldCase(javascriptRange);
      index += posixClass[0].length;
      continue;
    }
    if (erePattern[index] === "[" && "=.".includes(erePattern[index + 1] ?? "]")) return null;
    javascriptClass += "\\[]^".includes(erePattern[index]) ? `\\${erePattern[index]}` : foldCase(erePattern[index]);
    index += 1;
  }
  if (index >= erePattern.length) return null;
  return { javascriptClass: `${javascriptClass}]`, nextIndex: index + 1 };
}

function javascriptPatternFromEre(erePattern, foldCase) {
  let javascriptPattern = "";
  let index = 0;
  while (index < erePattern.length) {
    const character = erePattern[index];
    if (character === "[") {
      const bracketExpression = javascriptBracketExpression(erePattern, index, foldCase);
      if (bracketExpression === null) return null;
      javascriptPattern += bracketExpression.javascriptClass;
      index = bracketExpression.nextIndex;
      continue;
    }
    if (character !== "\\") {
      javascriptPattern += foldCase(character);
      index += 1;
      continue;
    }
    const escapedCharacter = erePattern[index + 1] ?? "";
    const javascriptEscape = JAVASCRIPT_ESCAPE_BY_ERE_ESCAPE.get(escapedCharacter) ?? (ERE_LITERAL_ESCAPES.has(escapedCharacter) ? `\\${escapedCharacter}` : null);
    if (javascriptEscape === null) return null;
    javascriptPattern += javascriptEscape;
    index += 2;
  }
  return javascriptPattern;
}

function linearTimeRegexOrNull(patternWord, foldCase) {
  if (SHELL_EXPANSION.test(patternWord.replace(SINGLE_QUOTED_LITERAL, ""))) return null;
  const javascriptPattern = javascriptPatternFromEre(unquotedShellWord(patternWord), foldCase);
  if (javascriptPattern === null) return null;
  try {
    return new RegExp(javascriptPattern, "ls");
  } catch {
    return null;
  }
}

function processCommandLinesOf(command) {
  const snapshotPath = path.join(os.homedir(), ".claude", "shell-snapshots", "snapshot-bash-0-0.sh");
  const workingDirectoryFilePath = path.join(process.env.CLAUDE_CODE_TMPDIR || os.tmpdir(), "claude-0000-cwd");
  const evalQuotedCommand = command.replaceAll("'", `'"'"'`);
  const claudeCodeBashToolShell = `/bin/bash -c source ${snapshotPath} 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval '${evalQuotedCommand}' && pwd -P >| ${workingDirectoryFilePath}`;
  return [command, claudeCodeBashToolShell];
}

function isSelfMatchingKill(argumentText, command) {
  const { optionWords, patternWord } = patternKillArguments(argumentText);
  if (patternWord === "" || !optionWords.some((word) => PKILL_FULL_FLAG.test(word))) return false;
  const isCaseInsensitive = optionWords.some((word) => CASE_INSENSITIVE_OPTION.test(word));
  const foldCase = isCaseInsensitive ? (text) => text.toLowerCase() : (text) => text;
  const pattern = linearTimeRegexOrNull(patternWord, foldCase);
  if (pattern === null) return !BRACKET_CLASS.test(patternWord);
  return processCommandLinesOf(command).some((commandLine) => pattern.test(foldCase(commandLine)));
}

function guardKillSelfMatch(command) {
  const isKillInCall = KILL_COMMAND_WORD.test(command);
  const killArgumentTexts = new Set();
  for (const [, toolName, argumentText] of command.matchAll(PATTERN_KILL_CALL)) {
    if (toolName === "pkill" || isKillInCall) killArgumentTexts.add(argumentText);
  }
  if ([...killArgumentTexts].some((argumentText) => isSelfMatchingKill(argumentText, command))) denyPreToolUse(KILL_SELF_MATCH_REASON);
}

async function guardRawCommit(command, transcriptPath) {
  if (!GIT_COMMIT_OR_PUSH.test(maskSingleQuotedText(maskLiteralHeredocBodies(command)))) return;
  if (fs.existsSync(transcriptPath) && (await hasLandingSkillRunSinceLastPrompt(transcriptPath))) return;
  denyPreToolUse(RAW_COMMIT_REASON);
}

function isSpecGatedPath(filePath) {
  const claudeDirectory = path.join(os.homedir(), ".claude");
  if (!path.isAbsolute(filePath) || isInsideDirectory(filePath, claudeDirectory)) return false;
  return isInsideGitWorktree(filePath);
}

async function denyUnlessSpecGateCleared(transcriptPath) {
  if (await hasSpecGateCleared(transcriptPath, specsDirectory())) return;
  denyPreToolUse(SPEC_GATE_REASON);
}

async function guardSpecFirst(filePath, transcriptPath) {
  if (!isSpecGatedPath(filePath)) allow();
  await denyUnlessSpecGateCleared(transcriptPath);
  allow();
}

function resolveShellPath(word, baseDirectory) {
  const unquotedWord = word.replace(/^(['"])(.*)\1$/, "$2");
  if (unquotedWord === "" || UNRESOLVABLE_PATH_CHARACTERS.test(unquotedWord)) return null;
  if (unquotedWord === "~" || unquotedWord.startsWith("~/")) return path.join(os.homedir(), unquotedWord.slice(1));
  return path.resolve(baseDirectory, unquotedWord);
}

function editedFileWords(commandName, argumentWords) {
  if (commandName === "tee") return argumentWords.filter((word) => !word.startsWith("-"));
  const isInPlace = argumentWords.some((word) => IN_PLACE_FLAG.test(word));
  if (!isInPlace) return [];
  const positionalWords = [];
  let hasInlineScript = false;
  for (let index = 0; index < argumentWords.length; index += 1) {
    const word = argumentWords[index];
    if (ATTACHED_SCRIPT_FLAG.test(word)) {
      hasInlineScript = true;
      continue;
    }
    if (SCRIPT_TAKING_FLAG.test(word) || (INLINE_SCRIPT_FLAG.test(word) && !word.includes("i"))) {
      hasInlineScript = true;
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) positionalWords.push(word);
  }
  const fileWords = hasInlineScript ? positionalWords : positionalWords.slice(1);
  return fileWords.length > 0 ? fileWords : [""];
}

function closingQuoteIndex(command, openingIndex) {
  const quote = command[openingIndex];
  for (let index = openingIndex + 1; index < command.length; index += 1) {
    if (quote === '"' && command[index] === "\\") index += 1;
    if (command[index] === quote) return index;
  }
  return -1;
}

function maskedQuotedWord(quotedText, quotedWord, isRunByShell) {
  if (isRunByShell) return `;${maskQuotedTextForWriteScan(quotedText)};`;
  return /\s/.test(quotedText) ? '""' : quotedWord;
}

function maskQuotedTextForWriteScan(command) {
  let maskedCommand = "";
  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (character === "\\") {
      maskedCommand += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character !== "'" && character !== '"') {
      maskedCommand += character;
      index += 1;
      continue;
    }
    const closingIndex = closingQuoteIndex(command, index);
    if (closingIndex === -1) return maskedCommand + command.slice(index);
    const quotedText = command.slice(index + 1, closingIndex);
    maskedCommand += maskedQuotedWord(quotedText, command.slice(index, closingIndex + 1), SHELL_RUNS_NEXT_WORD.test(maskedCommand));
    index = closingIndex + 1;
  }
  return maskedCommand;
}

function expandAssignedVariables(word, valueByName) {
  if (word.startsWith("'")) return word;
  return word.replace(VARIABLE_REFERENCE, (reference, bracedName, bareName) => valueByName.get(bracedName ?? bareName) ?? reference);
}

function topLevelStatements(command) {
  const statements = [];
  let statementStart = 0;
  let separatorBefore = "";
  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const closingIndex = closingQuoteIndex(command, index);
      index = closingIndex === -1 ? command.length : closingIndex + 1;
      continue;
    }
    const separator = command.slice(index).match(STATEMENT_SEPARATOR)?.[0];
    if (!separator) {
      index += 1;
      continue;
    }
    statements.push({ text: command.slice(statementStart, index).trim(), offset: statementStart, separatorBefore, separatorAfter: separator });
    separatorBefore = separator;
    index += separator.length;
    statementStart = index;
  }
  statements.push({ text: command.slice(statementStart).trim(), offset: statementStart, separatorBefore, separatorAfter: "" });
  return statements;
}

function assignedValueOf(rawValue, valueByName) {
  if (/^'[^']*'$/.test(rawValue)) return rawValue.slice(1, -1);
  const doubleQuoted = rawValue.match(/^"([^"]*)"$/);
  const unquotedValue = doubleQuoted ? doubleQuoted[1] : rawValue;
  if (!doubleQuoted && /['"]/.test(rawValue)) return null;
  return expandAssignedVariables(unquotedValue, valueByName);
}

function isRunUnconditionallyInThisShell({ separatorBefore, separatorAfter }) {
  return ["", ";", "\n"].includes(separatorBefore) && !["|", "&"].includes(separatorAfter);
}

function provenVariableValues(command) {
  const valueByName = new Map();
  if (CONDITIONAL_OR_SUBSHELL_CODE.test(command)) return valueByName;
  const bareWordCount = (name) => command.match(new RegExp(String.raw`(?<![$\w{])${name}(?!\w)`, "g")).length;
  const firstReferenceOffset = (name) => command.search(new RegExp(String.raw`\$\{?${name}(?!\w)`));
  for (const statement of topLevelStatements(command)) {
    const assignment = statement.text.match(PLAIN_ASSIGNMENT);
    if (!assignment || !isRunUnconditionallyInThisShell(statement)) continue;
    const [, name, rawValue] = assignment;
    const referenceOffset = firstReferenceOffset(name);
    const isAssignedOnceBeforeUse = bareWordCount(name) === 1 && (referenceOffset === -1 || referenceOffset > statement.offset);
    const value = isAssignedOnceBeforeUse ? assignedValueOf(rawValue, valueByName) : null;
    if (value !== null && !value.includes("$")) valueByName.set(name, value);
  }
  return valueByName;
}

function bashWriteTargets(command, sessionDirectory) {
  const commandWithoutLiteralHeredocs = maskLiteralHeredocBodies(command);
  const scannedCommand = maskQuotedTextForWriteScan(commandWithoutLiteralHeredocs);
  const valueByName = provenVariableValues(commandWithoutLiteralHeredocs);
  let baseDirectory = sessionDirectory;
  for (const [, directoryWord] of scannedCommand.matchAll(DIRECTORY_CHANGE)) baseDirectory = resolveShellPath(expandAssignedVariables(directoryWord, valueByName), baseDirectory) ?? baseDirectory;
  const fileInBaseDirectory = path.join(baseDirectory, UNRESOLVED_TARGET_NAME);
  const resolveTarget = (word) => resolveShellPath(expandAssignedVariables(word, valueByName), baseDirectory) ?? fileInBaseDirectory;
  const targets = [...scannedCommand.matchAll(OUTPUT_REDIRECT)].map((redirect) => resolveTarget(redirect[1]));
  for (const [, commandName, argumentText] of [...scannedCommand.matchAll(FILE_WRITING_COMMAND), ...scannedCommand.matchAll(FIND_EXEC_EDIT)]) {
    if (commandName === "patch" || commandName.startsWith("git")) {
      targets.push(fileInBaseDirectory);
      continue;
    }
    const argumentWords = argumentText.split(/[<>]/)[0].match(QUOTE_AWARE_WORD) ?? [];
    for (const word of editedFileWords(commandName, argumentWords)) targets.push(resolveTarget(word));
  }
  return [...new Set(targets)].filter((target) => !isInsideDirectory(target, "/dev"));
}

async function guardSpecFirstForBash(command, sessionDirectory, transcriptPath) {
  if (!bashWriteTargets(command, sessionDirectory).some(isSpecGatedPath)) return;
  await denyUnlessSpecGateCleared(transcriptPath);
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object" || payload.agent_id) allow();
  if (typeof payload.transcript_path !== "string") allow();
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (payload.tool_name === "Bash") await guardRawCommit(String(toolInput.command || ""), payload.transcript_path);
  if (!isAttendedMainLoopCall(payload) || !fs.existsSync(payload.transcript_path)) allow();
  const sessionDirectory = typeof payload.cwd === "string" && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  if (payload.tool_name === "Bash") guardKillSelfMatch(String(toolInput.command || ""));
  if (payload.tool_name === "Bash") await guardSpecFirstForBash(String(toolInput.command || ""), sessionDirectory, payload.transcript_path);
  if (EDIT_TOOLS.has(payload.tool_name)) await guardSpecFirst(String(toolInput.file_path || ""), payload.transcript_path);
  if (payload.tool_name === "AskUserQuestion") await guardUpstreamQuestions(toolInput, payload.transcript_path);
  allow();
}

try {
  await main();
} catch {
  allow();
}
