#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { allow, COMMAND_START, COMMAND_WRAPPERS, denyPreToolUse, isAttendedMainLoopCall, nearestExistingDirectory, readPayload } from "./hook-io.mjs";
import { isSkillRun, sessionEvents } from "./session-transcript.mjs";
import { declaredAgent, fileChangesOf } from "./agent-payload.mjs";
import { NO_UPSTREAM } from "../skills/specifying/lib/graph.ts";
import { specsDirectory } from "../skills/specifying/lib/spec-store.ts";

v8.setFlagsFromString("--enable-experimental-regexp-engine");

const SPEC_GATE_MARKER = "[spec-gate]";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SPEC_GATE_DENIAL_OPENING = `${SPEC_GATE_MARKER} This is the first repo edit`;
const SPEC_GATE_RETRY_OPENING = `${SPEC_GATE_MARKER} This retry`;
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
const GIT_ALIAS_TO_COMMIT_OR_PUSH = String.raw`-c\s*(?:alias\.[^=\s]+=\S*|"alias\.[^"=]+=[^"]*|'alias\.[^'=]+=[^']*)\b(?:commit|push)\b`;
const GIT_INVOCATION = String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?git['"]?${GIT_GLOBAL_OPTIONS}\s+`;
const GIT_COMMIT_OR_PUSH = new RegExp(
  String.raw`${GIT_INVOCATION}(?:(?:commit|push)(?=\s|$|[;&|)'"])|${GIT_ALIAS_TO_COMMIT_OR_PUSH})`,
  "m",
);
const SAME_COMMAND_TEXT = String.raw`(?:[^;&|\n]|\\\n)*?`;
const GIT_HOOK_BYPASS = new RegExp(
  String.raw`${GIT_INVOCATION}(?:(?:commit|push)\b${SAME_COMMAND_TEXT}\s--no-veri(?:fy?)?|commit\b${SAME_COMMAND_TEXT}\s-[aqsv]*n[A-Za-z]*)(?=[\s=;&|)'"]|$)`,
  "m",
);
const HOOKS_DISABLED_SETTING = /\bcore\.hooksPath\b|\bHUSKY=0\b/;
const LANDING_SKILLS = ["landing", "opening-prs"];
const GH_CALL = new RegExp(String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:\S*/)?gh['"]?(?=\s|$)([^;&|\n]*)`, "gm");
const GH_GLOBAL_OPTION_TAKING_VALUE = /^(?:-R|--repo|--hostname)$/;
const GH_PROSELESS_ACTIONS_BY_COMMAND = new Map([
  ["pr", new Set(["view", "list", "status", "diff", "checks", "checkout", "ready"])],
  ["issue", new Set(["view", "list", "status"])],
  ["repo", new Set(["view", "list", "clone", "fork", "sync"])],
  ["release", new Set(["view", "list", "download"])],
  ["label", new Set(["list"])],
]);
const GH_PROSELESS_COMMANDS = new Set(["auth", "browse", "config", "extension", "help", "run", "search", "stack", "workflow", "--version", "--help"]);
const GH_API_WRITE_FLAG = /^(?:-[fF]|--field|--raw-field|--input)/;
const GH_API_METHOD_FLAG = /^(?:-X|--method)(?:=?(.*))$/;

const VOICE_REASON =
  "Posting prose to GitHub as the carbon unit (a PR, issue, comment, or review) needs the writing-in-voice skill loaded first: run /writing-in-voice, draft the body to its rules and lint, then post. ai/AGENTS.md <writing_as_me>.";
const AGENT_FOOTER_TEXT = "Not written by a human";
const AGENT_FOOTER_LINE = "<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>";
const FOOTER_REASON =
  `A GitHub comment, review, or review-thread reply an agent posts ends with the Glimmervoid footer, so readers know an agent wrote it. Append this line to the body, then post: ${AGENT_FOOTER_LINE}`;
const GH_COMMENT_API_PATH = /(?:^|\/)(?:comments|replies|reviews)(?:\/\d+(?:\/events)?)?(?:\?|$)/;
const GH_COMMENT_MUTATION = /\b(?:add|submit|update)\w*(?:Comment|Review)\w*/;
const GH_BODY_WRITE_METHODS = new Set(["POST", "PATCH", "PUT"]);
const UNRESOLVABLE_PATH_WORD = /[$~`]/;
const GH_BODY_FILE_FLAG = /^(?:--body-file|-F|--field|--input)$/;
const GH_FIELD_FILE_VALUE = /^(?:-F|--field=?)?[^=@\s-][^=@\s]*=@(.+)$/;
const UPSTREAM_CLAUSE = /\bUpstream:[ \t]*(.*)$/gm;
const CHANGE_AT_SOURCE_LABEL = /\(change at the source\)/i;
const SKILLS_ENDING_SPECIFYING = [...LANDING_SKILLS, "gating-reviews", "reviewing-prs"];
const NEXT_SUBSKILL_BY_STATUS = { sketch: "grill.md", grilled: "slice.md", sliced: "challenge.md" };
const RULED_OUT_BY = /\S.*\bruled out by\s+\S/i;
const SPEC_ARCHIVE_RUN = /\bnode\s+(?:-\S+\s+)*\S*specifying\/archive\.ts\s/;
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
const RUNTIME_REBINDING = /(?:^|[\s;&|(])(?:source|\.|eval|(?:declare|typeset|local)\s+-\w*n\w*)(?=\s)|<\(/;
const STATEMENT_SEPARATOR =/^(?:&&|\|\||;;|[;\n|&])/;
const SHELL_RUNS_NEXT_WORD = /(?:\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-[A-Za-z]*c|\beval)\s*$/;
const IN_PLACE_FLAG = /^(?:-[A-Za-z0-9]*i|--in-place)/;
const SUFFIX_TAKING_IN_PLACE_FLAG = /^-[A-Za-z0-9]*i$/;
const EMPTY_SINGLE_QUOTED_WORD = "''";
const SCRIPT_TAKING_FLAG = /^(?:--expression|-f|--file)$/;
const ATTACHED_SCRIPT_FLAG = /^(?:--(?:expression|file)=|-e.)/;
const INLINE_SCRIPT_FLAG = /^-[A-Za-z0-9]*e$/;
const UNRESOLVABLE_PATH_CHARACTERS = /[$`*?[{]/;
const UNRESOLVED_TARGET_NAME = "unresolved-write-target";
const LITERAL_LOOP_HEADER = /(?:^|[\s;&|])for\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)[;\n]\s*do\b/g;
const SLASH_FREE_LOOP_WORD = /^[\w.-]+$/;
const LITERAL_WORD = /^[\w.:/@+=-]+$/;
const INERT_WORD = /^(?:[\w.:/@+=-]+|'[^']*'|"[^"$`\\]*")$/;
const ABSOLUTE_LITERAL_PATH = /^\/[\w.:/@+=-]*$/;
const DRY_RUN_PUSH_OPTIONS = new Set(["--dry-run", "-n", "--verbose", "-v", "--quiet", "-q", "--porcelain", "--set-upstream", "-u", "--force", "-f", "--tags"]);

const RAW_COMMIT_REASON =
  "Raw `git commit` and `git push` are denied outside /landing, so every landing commits a tree a review gate stamped. " +
  "Run the review gate (the intent's gate, else /gating-reviews), then /landing, which also commits without pushing (land.ts --no-push) when asked; /gating-reviews stamps a pure rename or a reviewer's suggestion applied verbatim without a review pass. " +
  "Never commit a WIP set-aside to integrate mainline: uncommitted work proceeds behind mainline, land.ts --promote rebases the landed commit onto it, and a conflict there resolves through landing recovery; work that needs mainline's new code before it can be finished is set aside as a patch instead: `git diff --binary HEAD > <scratchpad>/set-aside.patch`, unstage with `git reset -q`, delete each file the patch adds (`git apply --summary` names them as create mode), restore each other changed file with `git show HEAD:./<path> > <path>`, integrate mainline, then `git apply --3way <scratchpad>/set-aside.patch`. " +
  "Commits already made (a mainline sync's merge) push through /landing's land.ts with no message, which withholds any commit no review recorded. " +
  "A carbon unit who wants a raw commit runs it themselves with `! git ...`.";

const HOOK_BYPASS_REASON =
  "`git commit` or `git push` with --no-verify, `git commit -n`, or hooks turned off through core.hooksPath or HUSKY=0 skips the repo's hooks, which silences a check instead of fixing it. " +
  "Rerun without the flag and fix what the hook reports; a carbon unit who wants to skip hooks runs the command themselves with `! git ...`.";

function upstreamQuestionReason(unweighedQuestions) {
  const defects = unweighedQuestions.map(({ header, defect }) => `${header} (${defect})`).join("; ");
  return (
    `A /specifying question round must weigh a change at the source, and these questions do not: ${defects}. ` +
    "Give each one an option whose label carries `(change at the source)` when one is workable, else an `Upstream: <alternative>, ruled out by <evidence>` clause in the question, else an `Upstream: none: <reason>` clause when nothing sits above the choice."
  );
}

function misorderedSourceQuestionReason(misorderedHeaders) {
  return (
    `A /specifying question lists its \`(change at the source)\` option below another option: ${misorderedHeaders.join(", ")}. ` +
    "Move that option to first in each one; `(Recommended)` still goes to the option with the best design."
  );
}

const KILL_SELF_MATCH_REASON =
  "A kill by pattern (pkill -f, or pgrep -f feeding kill) matches full command lines, and this pattern matches text in this same Bash call, which its own shell carries, so the call kills itself. " +
  "Run the kill in its own Bash call with one character of the pattern bracketed ('[n]ode server'), so the pattern no longer matches its own text.";

const SPEC_FILE_RULE = "A task list entry, findings doc, or prompt is not a design spec: resume one by reading its file under ~/.agents/specs, which clears this gate.";
const STATED_SKIP_CASE = /\b(?:typo|mechanical|dictated|verbatim)\b|\bskip(?:ping)? (?:the )?\/?specifying\b|\bsaid (?:to )?skip\b/i;
const AGENTS_WITH_REPLY_EVENTS = new Set(["claude", "agy"]);
const SPEC_GATE_REASON =
  `${SPEC_GATE_MARKER} This is the first repo edit in a session that never ran /specifying. ` +
  "Any change that involves a choice goes through /specifying first: a feature, a behavior change, a refactor, a new skill, hook, agent, or config, a non-trivial bug fix, or a multi-file change. Run /specifying now. " +
  "Retry this same edit only for a typo or mechanical edit with no decision in it, an edit the carbon unit dictated verbatim, or when the carbon unit said to skip /specifying, and name which in your reply before the retry; \"small\" or \"obvious\" is not an exemption. " +
  `${SPEC_FILE_RULE} The gate fires once per session.`;
const SPEC_GATE_UNSTATED_REASON =
  `${SPEC_GATE_RETRY_OPENING} follows a spec-gate denial with no reply naming a case where /specifying does not apply. ${SPEC_FILE_RULE} ` +
  "Name the case in your reply (a typo or mechanical edit, an edit the carbon unit dictated verbatim, or the carbon unit said to skip /specifying), then retry; otherwise run /specifying.";

async function hasLandingSkillRunSinceLastPrompt(transcriptPath) {
  let hasLandingSkillRun = false;
  for await (const event of sessionEvents(transcriptPath)) {
    if (event.kind === "prompt") hasLandingSkillRun = false;
    if (LANDING_SKILLS.some((skillName) => isSkillRun(event, skillName))) hasLandingSkillRun = true;
  }
  return hasLandingSkillRun;
}

function isSpecArchiveCall(event) {
  return event.kind === "toolUse" && event.name === "Bash" && SPEC_ARCHIVE_RUN.test(String(event.input?.command ?? ""));
}

async function isSpecifyingUnfinished(transcriptPath) {
  let isUnfinished = false;
  const archiveCallIds = new Set();
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSpecArchiveCall(event)) archiveCallIds.add(event.id);
    if (isSkillRun(event, "specifying")) isUnfinished = true;
    const isArchived = event.kind === "toolResult" && !event.isError && archiveCallIds.has(event.toolUseId);
    if (isArchived || SKILLS_ENDING_SPECIFYING.some((skillName) => isSkillRun(event, skillName))) isUnfinished = false;
  }
  return isUnfinished;
}

function upstreamLineDefect(upstreamText) {
  const upstream = upstreamText.trim();
  if (/^none\b/i.test(upstream)) {
    if (NO_UPSTREAM.test(upstream)) return null;
    return "its `Upstream: none` clause needs `none: <reason>` with a reason of two or more words";
  }
  if (RULED_OUT_BY.test(upstream)) return null;
  return "its Upstream clause names no `ruled out by <evidence>` and is not `none: <reason>`";
}

function changeAtSourceOptionIndex(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  return options.findIndex((option) => CHANGE_AT_SOURCE_LABEL.test(String(option?.label || "")));
}

function upstreamDefect(question) {
  if (!question || typeof question !== "object") return "it is not a question object";
  if (changeAtSourceOptionIndex(question) !== -1) return null;
  const questionText = String(question.question || "");
  const lineDefects = [...questionText.matchAll(UPSTREAM_CLAUSE)].map((match) => upstreamLineDefect(match[1]));
  if (lineDefects.includes(null)) return null;
  if (lineDefects.length > 0) return lineDefects[0];
  return "it has no `Upstream:` clause and no `(change at the source)` option";
}

function questionHeader(question) {
  return String(question?.header || question?.question || "a question");
}

async function guardUpstreamQuestions(toolInput, transcriptPath) {
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const unweighedQuestions = questions
    .map((question) => ({ header: questionHeader(question), defect: upstreamDefect(question) }))
    .filter(({ defect }) => defect !== null);
  const misorderedHeaders = questions.filter((question) => changeAtSourceOptionIndex(question) > 0).map(questionHeader);
  if (unweighedQuestions.length === 0 && misorderedHeaders.length === 0) return;
  if (!(await isSpecifyingUnfinished(transcriptPath))) return;
  const reasons = [];
  if (unweighedQuestions.length > 0) reasons.push(upstreamQuestionReason(unweighedQuestions));
  if (misorderedHeaders.length > 0) reasons.push(misorderedSourceQuestionReason(misorderedHeaders));
  denyPreToolUse(reasons.join(" "));
}

function isInsideDirectory(filePath, directory) {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSpecGateDenial(event, editToolUseIds, denialOpening = SPEC_GATE_DENIAL_OPENING) {
  if (event.kind !== "toolResult" || !event.text.includes(denialOpening)) return false;
  if (declaredAgent() !== "claude") return editToolUseIds.has(event.toolUseId);
  return event.isError && event.text.startsWith("PreToolUse:");
}

function retryDenialReason(repliesSinceDenial) {
  if (!AGENTS_WITH_REPLY_EVENTS.has(declaredAgent())) return null;
  return repliesSinceDenial.some((replyText) => STATED_SKIP_CASE.test(replyText)) ? null : SPEC_GATE_UNSTATED_REASON;
}

async function specGateDenialReason(transcriptPath, specsDirectory) {
  const editToolUseIds = new Set();
  let repliesSinceDenial = null;
  for await (const event of sessionEvents(transcriptPath)) {
    if (["specifying", "gating-reviews"].some((skillName) => isSkillRun(event, skillName))) return null;
    if (event.kind === "toolUse" && EDIT_TOOLS.has(event.name)) editToolUseIds.add(event.id);
    if (isSpecGateDenial(event, editToolUseIds) || (repliesSinceDenial && isSpecGateDenial(event, editToolUseIds, SPEC_GATE_RETRY_OPENING))) {
      repliesSinceDenial = [];
      continue;
    }
    if (repliesSinceDenial && event.kind === "reply") repliesSinceDenial.push(event.text);
    if (event.kind !== "toolUse" || event.name !== "Read") continue;
    const readPath = String(event.input.file_path || "");
    if (path.isAbsolute(readPath) && isInsideDirectory(readPath, specsDirectory)) return null;
  }
  return repliesSinceDenial ? retryDenialReason(repliesSinceDenial) : SPEC_GATE_REASON;
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

function isPushDryRun(argumentWords) {
  return ["--dry-run", "-n"].includes(argumentWords[0]) && argumentWords.every((word) => LITERAL_WORD.test(word) && (!word.startsWith("-") || DRY_RUN_PUSH_OPTIONS.has(word)));
}

function isThrowawayRepositoryPath(repositoryDirectory) {
  if (!fs.existsSync(os.tmpdir()) || !fs.existsSync(repositoryDirectory)) return false;
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const resolvedDirectory = fs.realpathSync(repositoryDirectory);
  const dotGitPath = path.join(resolvedDirectory, ".git");
  if (resolvedDirectory === temporaryRoot || !isInsideDirectory(resolvedDirectory, temporaryRoot) || !fs.existsSync(dotGitPath)) return false;
  return fs.lstatSync(dotGitPath).isDirectory() && !fs.existsSync(path.join(dotGitPath, "commondir"));
}

function isThrowawayGitCall(words) {
  const directoryPaths = [];
  let wordIndex = 1;
  for (; ["-C", "-c"].includes(words[wordIndex]); wordIndex += 2) {
    const optionValue = words[wordIndex + 1] ?? "";
    if (words[wordIndex] === "-C" && ABSOLUTE_LITERAL_PATH.test(optionValue)) {
      directoryPaths.push(optionValue);
      continue;
    }
    if (words[wordIndex] === "-c" && LITERAL_WORD.test(optionValue) && !/^alias\./i.test(optionValue)) continue;
    return false;
  }
  const [subcommand, ...argumentWords] = words.slice(wordIndex);
  if (subcommand === "push") return wordIndex === 1 && isPushDryRun(argumentWords);
  return subcommand === "commit" && directoryPaths.length > 0 && isThrowawayRepositoryPath(path.resolve(...directoryPaths));
}

function isEveryCommitOrPushThrowaway(command) {
  const wordsOfEachStatement = topLevelStatements(command).map((statement) => statement.text.match(QUOTE_AWARE_WORD) ?? []);
  return wordsOfEachStatement.every((words) => words[0] === "git" && words.every((word) => INERT_WORD.test(word)) && isThrowawayGitCall(words));
}

async function hasSkillRunInSession(transcriptPath, skillName) {
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, skillName)) return true;
  }
  return false;
}

function ghApiMethodOf(words) {
  const methodFlagIndex = words.findIndex((word) => GH_API_METHOD_FLAG.test(word));
  if (methodFlagIndex === -1) return words.some((word) => GH_API_WRITE_FLAG.test(word)) ? "POST" : "GET";
  const attachedMethod = words[methodFlagIndex].match(GH_API_METHOD_FLAG)[1];
  return (attachedMethod || words[methodFlagIndex + 1] || "").replace(/['"]/g, "").toUpperCase();
}

function ghCallMayPostProse(argumentText) {
  const words = ghCallWords(argumentText);
  const positionalWords = [];
  for (let index = 0; index < words.length; index += 1) {
    if (GH_GLOBAL_OPTION_TAKING_VALUE.test(words[index]) && positionalWords.length === 0) {
      index += 1;
      continue;
    }
    if (words[index].startsWith("-") && positionalWords.length === 0 && !GH_PROSELESS_COMMANDS.has(words[index])) continue;
    positionalWords.push(words[index]);
  }
  const [command = "", action = ""] = positionalWords;
  if (command === "" || GH_PROSELESS_COMMANDS.has(command)) return false;
  if (command === "api") return ghApiMethodOf(words) !== "GET";
  return !GH_PROSELESS_ACTIONS_BY_COMMAND.get(command)?.has(action);
}

function ghCallWords(argumentText) {
  return (argumentText.match(QUOTE_AWARE_WORD) ?? []).map((word) => word.replace(/^['"]|['"]$/g, ""));
}

function ghPositionalWords(words) {
  const positionalWords = [];
  for (let index = 0; index < words.length; index += 1) {
    if (GH_GLOBAL_OPTION_TAKING_VALUE.test(words[index]) && positionalWords.length === 0) {
      index += 1;
      continue;
    }
    if (words[index].startsWith("-")) continue;
    positionalWords.push(words[index]);
  }
  return positionalWords;
}

function namedBodyFiles(argumentText) {
  const words = ghCallWords(argumentText);
  const filePaths = [];
  for (let index = 0; index < words.length; index += 1) {
    const fieldFile = words[index].match(GH_FIELD_FILE_VALUE);
    if (fieldFile) filePaths.push(fieldFile[1]);
    const nextWord = words[index + 1] ?? "";
    if (GH_BODY_FILE_FLAG.test(words[index]) && nextWord !== "" && !nextWord.includes("=")) filePaths.push(nextWord);
    if (/^--(?:body-file|input)=/.test(words[index])) filePaths.push(words[index].slice(words[index].indexOf("=") + 1));
  }
  return filePaths;
}

function readFileText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function ghCallPostsComment(argumentText, cwd) {
  const words = ghCallWords(argumentText);
  const positionalWords = ghPositionalWords(words);
  const [command = "", action = ""] = positionalWords;
  const hasBodyFlag = words.some((word) => /^(?:-b|--body|--body-file|-F)(?:=|$)/.test(word) || /^-b\S/.test(word));
  if ((command === "pr" || command === "issue") && action === "comment") return true;
  if (command === "pr" && action === "review") return hasBodyFlag;
  if ((command === "pr" || command === "issue") && (action === "close" || action === "reopen")) return words.some((word) => /^(?:-c|--comment)(?:=|$)/.test(word));
  if (command !== "api" || !GH_BODY_WRITE_METHODS.has(ghApiMethodOf(words))) return false;
  const apiWords = positionalWords.slice(1);
  if (!apiWords.includes("graphql")) return apiWords.some((word) => GH_COMMENT_API_PATH.test(word));
  const queryFileText = namedBodyFiles(argumentText).map((filePath) => readFileText(path.resolve(cwd, filePath))).join("\n");
  return GH_COMMENT_MUTATION.test(argumentText) || GH_COMMENT_MUTATION.test(queryFileText);
}

function commentCallHasFooter(argumentText, callSegment, command, cwd) {
  if (callSegment.includes(AGENT_FOOTER_TEXT)) return true;
  const bodyFiles = namedBodyFiles(argumentText);
  if (bodyFiles.includes("-")) return command.includes(AGENT_FOOTER_TEXT);
  if (bodyFiles.some((filePath) => UNRESOLVABLE_PATH_WORD.test(filePath)) || /(?:^|[;&|(\s])cd\s/.test(command)) return true;
  return bodyFiles.some((filePath) => readFileText(path.resolve(cwd, filePath)).includes(AGENT_FOOTER_TEXT));
}

function guardCommentFooter(command, cwd) {
  const scannedCommand = maskLiteralHeredocBodies(command.replace(/\\\r?\n/g, " "));
  const ghCalls = [...scannedCommand.matchAll(GH_CALL)];
  const isEveryCommentFootered = ghCalls.every((match, callIndex) => {
    if (!ghCallPostsComment(match[1], cwd)) return true;
    const callSegment = scannedCommand.slice(match.index, ghCalls[callIndex + 1]?.index ?? scannedCommand.length);
    return commentCallHasFooter(match[1], callSegment, command, cwd);
  });
  if (isEveryCommentFootered) return;
  denyPreToolUse(FOOTER_REASON);
}

async function guardProsePost(command, transcriptPath) {
  const scannedCommand = maskSingleQuotedText(maskLiteralHeredocBodies(command.replace(/\\\r?\n/g, " ")));
  const ghArgumentTexts = [...scannedCommand.matchAll(GH_CALL)].map((match) => match[1]);
  if (!ghArgumentTexts.some(ghCallMayPostProse)) return;
  if (!fs.existsSync(transcriptPath) || (await hasSkillRunInSession(transcriptPath, "writing-in-voice"))) return;
  denyPreToolUse(VOICE_REASON);
}

async function guardRawCommit(command, transcriptPath) {
  const executedText = maskSingleQuotedText(maskLiteralHeredocBodies(command));
  if (!GIT_COMMIT_OR_PUSH.test(executedText)) return;
  if (isEveryCommitOrPushThrowaway(command)) return;
  const hasLandingRun = fs.existsSync(transcriptPath) && (await hasLandingSkillRunSinceLastPrompt(transcriptPath));
  if (!hasLandingRun) denyPreToolUse(RAW_COMMIT_REASON);
  const executedTextOutsideQuotes = maskQuotedTextForWriteScan(maskLiteralHeredocBodies(command))
    .replace(/(["'])([^"']*)\1/g, (quotedWord, quote, quotedText) => (/[;&|]/.test(quotedText) ? '""' : quotedWord));
  if (GIT_HOOK_BYPASS.test(executedTextOutsideQuotes) || HOOKS_DISABLED_SETTING.test(executedTextOutsideQuotes)) denyPreToolUse(HOOK_BYPASS_REASON);
}

function isSpecGatedPath(filePath) {
  const claudeDirectory = path.join(os.homedir(), ".claude");
  if (!path.isAbsolute(filePath) || isInsideDirectory(filePath, claudeDirectory)) return false;
  return isInsideGitWorktree(filePath);
}

function isDesignSpecFile(filePath) {
  return isInsideDirectory(filePath, specsDirectory()) && filePath.endsWith(".json") && !filePath.endsWith(".intent.json");
}

function writtenFilePaths(event, sessionDirectory) {
  if (event.kind !== "toolUse") return [];
  if (EDIT_TOOLS.has(event.name)) return [String(event.input?.file_path || "")];
  if (event.name === "Bash") return bashWriteTargets(String(event.input?.command || "").replace(/\$\{HOME\}|\$HOME\b/g, os.homedir()), sessionDirectory);
  return [];
}

async function specPathsWrittenInOpenSpecifyingRun(transcriptPath, sessionDirectory) {
  let specPaths = new Set();
  let isSpecifyingOpen = false;
  for await (const event of sessionEvents(transcriptPath)) {
    if (isSkillRun(event, "specifying")) {
      isSpecifyingOpen = true;
      specPaths = new Set();
    }
    if (SKILLS_ENDING_SPECIFYING.some((skillName) => isSkillRun(event, skillName))) isSpecifyingOpen = false;
    if (!isSpecifyingOpen) continue;
    for (const filePath of writtenFilePaths(event, sessionDirectory)) {
      if (isDesignSpecFile(filePath)) specPaths.add(filePath);
    }
  }
  return isSpecifyingOpen ? [...specPaths] : [];
}

function readSpec(specPath) {
  try {
    return JSON.parse(fs.readFileSync(specPath, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function nextSubskill(spec) {
  const hasOpenBranch = Array.isArray(spec.nodes) && spec.nodes.some((node) => node?.kind === "branch");
  if (spec.status === "sketch" && !hasOpenBranch) return "design.md";
  return NEXT_SUBSKILL_BY_STATUS[spec.status];
}

function unchallengedSpec(specPaths) {
  for (const specPath of specPaths) {
    const spec = readSpec(specPath);
    if (Object.hasOwn(NEXT_SUBSKILL_BY_STATUS, spec.status)) return { specPath, status: spec.status, subskill: nextSubskill(spec) };
  }
  return null;
}

function isGitIgnored(filePath) {
  if (path.basename(filePath) === UNRESOLVED_TARGET_NAME) return false;
  const ignoreProbe = spawnSync("git", ["-C", nearestExistingDirectory(filePath), "check-ignore", "-q", filePath], { timeout: 2000, killSignal: "SIGKILL" });
  return ignoreProbe.status === 0;
}

function unchallengedSpecReason({ specPath, status, subskill }) {
  return `${SPEC_GATE_MARKER} Design spec ${specPath} is at ${status}, and this session's /specifying run must reach challenged before it edits the repo. ` +
    `Run subskills/${subskill} of /specifying next, or archive the spec abandoned with archive.ts. Git-ignored files, such as a mockup harness, stay editable.`;
}

async function denyUnlessSpecGateCleared(transcriptPath, editedPaths, sessionDirectory) {
  const specGateReason = await specGateDenialReason(transcriptPath, specsDirectory());
  if (specGateReason) denyPreToolUse(specGateReason);
  if (editedPaths.every(isGitIgnored)) return;
  const pendingSpec = unchallengedSpec(await specPathsWrittenInOpenSpecifyingRun(transcriptPath, sessionDirectory));
  if (pendingSpec) denyPreToolUse(unchallengedSpecReason(pendingSpec));
}

function resolveShellPath(word, baseDirectory) {
  const unquotedWord = word.replace(/^(['"])(.*)\1$/, "$2");
  if (unquotedWord === "" || UNRESOLVABLE_PATH_CHARACTERS.test(unquotedWord)) return null;
  if (unquotedWord === "~" || unquotedWord.startsWith("~/")) return path.join(os.homedir(), unquotedWord.slice(1));
  return path.resolve(baseDirectory, unquotedWord);
}

function fileInResolvedDirectory(expandedWord, baseDirectory, loopVariableNames) {
  const unquotedWord = expandedWord.replace(/^(['"])(.*)\1$/, "$2");
  const fileNameStart = unquotedWord.lastIndexOf("/") + 1;
  const fileName = unquotedWord.slice(fileNameStart);
  const unresolvedNames = [...fileName.matchAll(VARIABLE_REFERENCE)].map(([, bracedName, bareName]) => bracedName ?? bareName);
  if (fileNameStart === 0 || /`|\$\(/.test(fileName) || unresolvedNames.length === 0) return null;
  if (!unresolvedNames.every((name) => loopVariableNames.has(name))) return null;
  const directory = resolveShellPath(unquotedWord.slice(0, fileNameStart), baseDirectory);
  return directory && path.join(directory, UNRESOLVED_TARGET_NAME);
}

function editedFileWords(commandName, argumentWords, namesExistingPath) {
  if (commandName === "tee") return argumentWords.filter((word) => !word.startsWith("-"));
  const isInPlace = argumentWords.some((word) => IN_PLACE_FLAG.test(word));
  if (!isInPlace) return [];
  const positionalWords = [];
  let hasInlineScript = false;
  let hasEmptyBackupSuffix = false;
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
    if (SUFFIX_TAKING_IN_PLACE_FLAG.test(word) && argumentWords[index + 1] === EMPTY_SINGLE_QUOTED_WORD) {
      hasEmptyBackupSuffix = true;
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) positionalWords.push(word);
  }
  const isScriptSlotAnExistingPath = hasEmptyBackupSuffix && positionalWords.length > 0 && namesExistingPath(positionalWords[0]);
  const fileWords = hasInlineScript || isScriptSlotAnExistingPath ? positionalWords : positionalWords.slice(1);
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
  if (/\s/.test(quotedText)) return '""';
  const isLiteralText = quotedWord.startsWith("'") || !/\$\(|`/.test(quotedText);
  return isLiteralText ? quotedWord.replace(/[<>]/g, "_") : quotedWord;
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

function expandAssignedVariables(word, valueByName, conditionalNames = new Set()) {
  if (word.startsWith("'")) return word;
  return word.replace(VARIABLE_REFERENCE, (reference, bracedName, bareName, offset) => {
    const name = bracedName ?? bareName;
    if (!valueByName.has(name)) return reference;
    const isRootedWhenUnset = /^"?$/.test(word.slice(0, offset)) && word[offset + reference.length] === "/";
    return !conditionalNames.has(name) || isRootedWhenUnset ? valueByName.get(name) : reference;
  });
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

function assignedValueOf(rawValue, valueByName, conditionalNames) {
  if (/^'[^']*'$/.test(rawValue)) return rawValue.slice(1, -1);
  const doubleQuoted = rawValue.match(/^"([^"]*)"$/);
  const unquotedValue = doubleQuoted ? doubleQuoted[1] : rawValue;
  if (!doubleQuoted && /['"]/.test(rawValue)) return null;
  return expandAssignedVariables(unquotedValue, valueByName, conditionalNames);
}

function isRunUnconditionallyInThisShell({ separatorBefore, separatorAfter }) {
  return ["", ";", "\n"].includes(separatorBefore) && !["|", "&"].includes(separatorAfter);
}

function firstControlKeywordIndex(command) {
  const controlMatch = CONDITIONAL_OR_SUBSHELL_CODE.exec(command);
  if (!controlMatch) return command.length;
  const hasLeadingSeparator = controlMatch[0].length > 1 && /^[\s;&|]/.test(controlMatch[0]);
  return controlMatch.index + (hasLeadingSeparator ? 1 : 0);
}

function provenVariableValues(command) {
  const valueByName = new Map();
  const conditionalNames = new Set();
  const bareWordCount = (name) => command.match(new RegExp(String.raw`(?<![$\w{])${name}(?!\w)`, "g")).length;
  const firstReferenceOffset = (name) => command.search(new RegExp(String.raw`\$\{?${name}(?!\w)`));
  if (RUNTIME_REBINDING.test(command)) return { valueByName, conditionalNames };
  const statements = topLevelStatements(command);
  const controlKeywordIndex = firstControlKeywordIndex(command);
  const isCompleteBeforeControl = (index) => (statements[index + 1]?.offset ?? command.length) <= controlKeywordIndex;
  for (const [index, statement] of statements.entries()) {
    if (!isCompleteBeforeControl(index)) break;
    const assignment = statement.text.match(PLAIN_ASSIGNMENT);
    const isRunAfterSuccess = statement.separatorBefore === "&&" && !["|", "&"].includes(statement.separatorAfter);
    if (!assignment || !(isRunUnconditionallyInThisShell(statement) || isRunAfterSuccess)) continue;
    const [, name, rawValue] = assignment;
    const referenceOffset = firstReferenceOffset(name);
    const isAssignedOnceBeforeUse = bareWordCount(name) === 1 && (referenceOffset === -1 || referenceOffset > statement.offset);
    const value = isAssignedOnceBeforeUse ? assignedValueOf(rawValue, valueByName, conditionalNames) : null;
    if (value === null || value.includes("$")) continue;
    valueByName.set(name, value);
    if (isRunAfterSuccess) conditionalNames.add(name);
  }
  return { valueByName, conditionalNames };
}

function literalLoopVariableNames(command) {
  const loopVariableNames = new Set();
  if (RUNTIME_REBINDING.test(command)) return loopVariableNames;
  for (const [, name, loopWordList] of command.matchAll(LITERAL_LOOP_HEADER)) {
    const isBoundOnlyByThisLoop = command.match(new RegExp(String.raw`(?<![$\w{])${name}(?!\w)`, "g")).length === 1;
    const hasOnlySlashFreeWords = loopWordList.trim().split(/\s+/).every((loopWord) => SLASH_FREE_LOOP_WORD.test(loopWord) && !/^\.\.?$/.test(loopWord));
    if (isBoundOnlyByThisLoop && hasOnlySlashFreeWords) loopVariableNames.add(name);
  }
  return loopVariableNames;
}

function bashWriteTargets(command, sessionDirectory) {
  const commandWithoutLiteralHeredocs = maskLiteralHeredocBodies(command);
  const scannedCommand = maskQuotedTextForWriteScan(commandWithoutLiteralHeredocs);
  const { valueByName, conditionalNames } = provenVariableValues(commandWithoutLiteralHeredocs);
  const loopVariableNames = literalLoopVariableNames(commandWithoutLiteralHeredocs);
  let baseDirectory = sessionDirectory;
  const scannedControlKeywordIndex = firstControlKeywordIndex(scannedCommand);
  for (const directoryChange of scannedCommand.matchAll(DIRECTORY_CHANGE)) {
    const isUnconditionalDirectoryChange = directoryChange.index < scannedControlKeywordIndex;
    const directoryWord = expandAssignedVariables(directoryChange[1], isUnconditionalDirectoryChange ? valueByName : new Map(), conditionalNames);
    baseDirectory = resolveShellPath(directoryWord, baseDirectory) ?? baseDirectory;
  }
  const fileInBaseDirectory = path.join(baseDirectory, UNRESOLVED_TARGET_NAME);
  const resolveTarget = (word) => {
    const expandedWord = expandAssignedVariables(word, valueByName, conditionalNames);
    return resolveShellPath(expandedWord, baseDirectory) ?? fileInResolvedDirectory(expandedWord, baseDirectory, loopVariableNames) ?? fileInBaseDirectory;
  };
  const targets = [...scannedCommand.matchAll(OUTPUT_REDIRECT)].map((redirect) => resolveTarget(redirect[1]));
  for (const [, commandName, argumentText] of [...scannedCommand.matchAll(FILE_WRITING_COMMAND), ...scannedCommand.matchAll(FIND_EXEC_EDIT)]) {
    if (commandName === "patch" || commandName.startsWith("git")) {
      targets.push(fileInBaseDirectory);
      continue;
    }
    const argumentWords = argumentText.split(/[<>]/)[0].match(QUOTE_AWARE_WORD) ?? [];
    for (const word of editedFileWords(commandName, argumentWords, (candidate) => fs.existsSync(resolveTarget(candidate)))) targets.push(resolveTarget(word));
  }
  return [...new Set(targets)].filter((target) => !isInsideDirectory(target, "/dev"));
}

async function guardSpecFirstForBash(command, sessionDirectory, transcriptPath) {
  const gatedTargets = bashWriteTargets(command, sessionDirectory).filter(isSpecGatedPath);
  if (gatedTargets.length === 0) return;
  await denyUnlessSpecGateCleared(transcriptPath, gatedTargets, sessionDirectory);
}

const COMMAND_END = String.raw`(?=\s|$|[;&|)'"])`;
const OPTION_WORDS = String.raw`(?:\s+-\S+(?:\s+[^-\s;&|]\S*)?)*`;
const LONG_COMMANDS = [
  String.raw`(?:\S*/)?run-all\.sh`,
  String.raw`(?:\S*/)?script/bootstrap`,
  String.raw`(?:\S*/)?dot(?!\s+(?:status|-h|--help)\b)${COMMAND_END}`,
  String.raw`(?:npm|pnpm|yarn|bun)${OPTION_WORDS}\s+(?:install|i|ci|add|it|cit|install-clean|install-test)${COMMAND_END}`,
  String.raw`yarn(?:\s+-\S+)*(?=\s*(?:$|[;&|)'"]))`,
  String.raw`apt(?:-get)?${OPTION_WORDS}\s+install\b`,
  String.raw`brew${OPTION_WORDS}\s+(?:install|bundle)\b`,
];
const FOREGROUND_LONG_COMMAND = new RegExp(String.raw`${COMMAND_START}\s*${COMMAND_WRAPPERS}['"\\]*(?:(?:ba|z|da)?sh(?:\s+-\S+)*\s+)?['"\\]*(?:${LONG_COMMANDS.join("|")})`, "m");
const BACKGROUND_TASKS_DISABLED_VARIABLES = ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_SIMPLE"];

function guardForegroundBuild(toolInput) {
  if (toolInput.run_in_background === true) return;
  if (BACKGROUND_TASKS_DISABLED_VARIABLES.some((variableName) => /^(?:1|true|yes)$/i.test(process.env[variableName] ?? ""))) return;
  const scannedCommand = maskSingleQuotedText(maskLiteralHeredocBodies(String(toolInput.command || "").replace(/\\\r?\n/g, " ")));
  const longCommand = FOREGROUND_LONG_COMMAND.exec(scannedCommand);
  if (!longCommand) return;
  denyPreToolUse(
    `This runs \`${longCommand[0].trim()}\` in the foreground, which blocks the loop for minutes. ` +
    "<execution> requires builds, full suites, installs, and converges never to hold the loop past a short wait; rerun the same command in the background (run_in_background: true, or WaitMsBeforeAsync of 10000 or less) and wait for its completion notification.",
  );
}

async function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (payload.tool_name === "Bash" && payload.tool_input && typeof payload.tool_input === "object") guardForegroundBuild(payload.tool_input);
  if (payload.agent_id) allow();
  if (typeof payload.transcript_path !== "string") allow();
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (payload.tool_name === "Bash") await guardRawCommit(String(toolInput.command || ""), payload.transcript_path);
  if (payload.tool_name === "Bash") await guardProsePost(String(toolInput.command || ""), payload.transcript_path);
  if (payload.tool_name === "Bash") guardCommentFooter(String(toolInput.command || ""), typeof payload.cwd === "string" && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd());
  if (!isAttendedMainLoopCall(payload) || !fs.existsSync(payload.transcript_path)) allow();
  const sessionDirectory = typeof payload.cwd === "string" && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  if (payload.tool_name === "Bash") guardKillSelfMatch(String(toolInput.command || ""));
  if (payload.tool_name === "Bash") await guardSpecFirstForBash(String(toolInput.command || ""), sessionDirectory, payload.transcript_path);
  const gatedFilePaths = fileChangesOf(payload).map((change) => String(change.tool_input.file_path || "")).filter(isSpecGatedPath);
  if (gatedFilePaths.length > 0) await denyUnlessSpecGateCleared(payload.transcript_path, gatedFilePaths, sessionDirectory);
  if (payload.tool_name === "AskUserQuestion") await guardUpstreamQuestions(toolInput, payload.transcript_path);
  allow();
}

try {
  await main();
} catch {
  allow();
}
