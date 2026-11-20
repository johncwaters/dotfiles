import path from "node:path";
import { codeLinesOf, syntaxFor } from "./comment-scanner.mjs";

const VAGUE_NAMES = new Set(["data", "tmp", "temp", "info", "result", "res", "val", "obj"]);
const LOOP_COUNTER_NAMES = new Set(["i", "j"]);
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);
const NON_FUNCTION_WORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "typeof", "await", "new", "super", "import", "else", "do"]);
const MAX_STATEMENT_LINES = 40;
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

const JS_DECLARATION_KEYWORD_RE = /\b(?:const|let|var)\s+/g;
const JS_DECLARATOR_NAME_RE = new RegExp(String.raw`^(${IDENTIFIER})(?=\s*[=:;)]|\s+(?:of|in)\b|\s*$)`);
const JS_FUNCTION_RE = new RegExp(String.raw`\bfunction\b\s*\*?\s*(${IDENTIFIER})?\s*(?:<[^()]*>)?\s*\(([^()]*)\)`, "g");
const JS_METHOD_RE = new RegExp(String.raw`^\s*(?:(?:async|static|public|private|protected|get|set)\s+)*(${IDENTIFIER})\s*(?:<[^()]*>)?\s*\(([^()]*)\)\s*(?::[^{=]*)?\{`, "g");
const JS_ARROW_PARAMETERS_RE = new RegExp(String.raw`\(([^()]*)\)\s*(?::\s*[^=()]+?)?\s*=>`, "g");
const JS_BARE_ARROW_PARAMETER_RE = new RegExp(String.raw`(?:^|[^\w$.)])(${IDENTIFIER})\s*=>`, "g");
const JS_CATCH_RE = new RegExp(String.raw`\bcatch\s*\(\s*(${IDENTIFIER})\s*\)`, "g");
const JS_LOOP_COUNTER_RE = /\bfor\s*\(\s*(?:let|var)\s+([ij])\b/g;

const PYTHON_FUNCTION_RE = new RegExp(String.raw`\bdef\s+(${IDENTIFIER})\s*\(([^()]*)\)?`, "g");
const PYTHON_LAMBDA_RE = new RegExp(String.raw`\blambda\s+([^:]*):`, "g");
const PYTHON_ASSIGNMENT_RE = new RegExp(String.raw`^\s*(${IDENTIFIER}(?:\s*,\s*${IDENTIFIER})*)\s*(?::[^=]+)?=(?!=)`);
const PYTHON_FOR_RE = new RegExp(String.raw`\bfor\s+(${IDENTIFIER}(?:\s*,\s*${IDENTIFIER})*)\s+in\b`, "g");
const PYTHON_AS_TARGET_RE = new RegExp(String.raw`\bas\s+(${IDENTIFIER})\b`, "g");
const PYTHON_WALRUS_RE = new RegExp(String.raw`(${IDENTIFIER})\s*:=`, "g");
const PYTHON_LOOP_COUNTER_RE = /\bfor\s+([ij])\s+in\b/g;

function namingSyntaxFor(filePath) {
  const extension = path.extname(String(filePath)).toLowerCase();
  if (!JS_EXTENSIONS.has(extension) && extension !== ".py") return null;
  return { ...syntaxFor(filePath), namingLanguage: extension === ".py" ? "python" : "javascript" };
}

function topLevelPartsOf(text, stopAtSemicolon = false) {
  const parts = [];
  let depth = 0;
  let current = "";
  let previousCharacter = "";
  for (const character of text) {
    if (stopAtSemicolon && character === ";" && depth <= 0) break;
    if ("([{<".includes(character)) depth++;
    if (")]}".includes(character) || (character === ">" && previousCharacter !== "=")) depth--;
    previousCharacter = character;
    if (character !== "," || depth > 0) {
      current += character;
      continue;
    }
    parts.push(current.trim());
    current = "";
  }
  parts.push(current.trim());
  return parts;
}

function parameterNamesOf(parameterList) {
  const names = [];
  for (const part of topLevelPartsOf(parameterList)) {
    const parameter = part.replace(/^\.\.\.|^\*{1,2}/, "");
    const name = parameter.match(new RegExp(`^${IDENTIFIER}`))?.[0];
    if (name && name !== "self" && name !== "cls") names.push(name);
  }
  return names;
}

function declaredNamesOf(code) {
  const names = [];
  for (const keyword of code.matchAll(JS_DECLARATION_KEYWORD_RE)) {
    const declarators = topLevelPartsOf(code.slice(keyword.index + keyword[0].length), true);
    for (const declarator of declarators) {
      const name = declarator.match(JS_DECLARATOR_NAME_RE)?.[1];
      if (name) names.push(name);
    }
  }
  return names;
}

function bracketBalanceOf(code) {
  return (code.match(/[([]/g) ?? []).length - (code.match(/[)\]]/g) ?? []).length;
}

function* statementsOf(content, syntax) {
  let pendingLines = [];
  let openBrackets = 0;
  for (const codeLine of codeLinesOf(content, syntax)) {
    pendingLines.push(codeLine);
    openBrackets += bracketBalanceOf(codeLine.code);
    if (openBrackets > 0 && pendingLines.length < MAX_STATEMENT_LINES) continue;
    yield pendingLines;
    pendingLines = [];
    openBrackets = 0;
  }
  if (pendingLines.length > 0) yield pendingLines;
}

function* capturedNames(code, pattern, toNames) {
  for (const match of code.matchAll(pattern)) yield* toNames(match);
}

function javascriptBindingsOf(code) {
  return [
    ...declaredNamesOf(code),
    ...capturedNames(code, JS_FUNCTION_RE, (match) => [match[1], ...parameterNamesOf(match[2])].filter(Boolean)),
    ...capturedNames(code, JS_METHOD_RE, (match) => (NON_FUNCTION_WORDS.has(match[1]) ? [] : [match[1], ...parameterNamesOf(match[2])])),
    ...capturedNames(code, JS_ARROW_PARAMETERS_RE, (match) => parameterNamesOf(match[1])),
    ...capturedNames(code, JS_BARE_ARROW_PARAMETER_RE, (match) => [match[1]]),
    ...capturedNames(code, JS_CATCH_RE, (match) => [match[1]]),
  ];
}

function pythonBindingsOf(code) {
  const assignedNames = code.match(PYTHON_ASSIGNMENT_RE)?.[1].split(",").map((name) => name.trim()) ?? [];
  return [
    ...assignedNames,
    ...capturedNames(code, PYTHON_FUNCTION_RE, (match) => [match[1], ...parameterNamesOf(match[2] ?? "")]),
    ...capturedNames(code, PYTHON_LAMBDA_RE, (match) => parameterNamesOf(match[1])),
    ...capturedNames(code, PYTHON_FOR_RE, (match) => match[1].split(",").map((name) => name.trim())),
    ...capturedNames(code, PYTHON_AS_TARGET_RE, (match) => [match[1]]),
    ...capturedNames(code, PYTHON_WALRUS_RE, (match) => [match[1]]),
  ];
}

function isVagueName(name, loopCounters) {
  if (VAGUE_NAMES.has(name)) return true;
  if (name.length !== 1 || name === "_" || name === "$") return false;
  return !(LOOP_COUNTER_NAMES.has(name) && loopCounters.has(name));
}

function lineDeclaring(name, statementLines) {
  const namePattern = new RegExp(`(?<![\\w$])${name.replace("$", "\\$")}(?![\\w$])`);
  const declaringLine = statementLines.find((codeLine) => namePattern.test(codeLine.code)) ?? statementLines[0];
  return declaringLine.line.trim();
}

function scanVagueNameLines(content, syntax) {
  const isPython = syntax.namingLanguage === "python";
  const found = [];
  for (const statementLines of statementsOf(content, syntax)) {
    const code = statementLines.map((codeLine) => codeLine.code.trim()).join(" ");
    const bindings = isPython ? pythonBindingsOf(code) : javascriptBindingsOf(code);
    const loopCounters = new Set([...code.matchAll(isPython ? PYTHON_LOOP_COUNTER_RE : JS_LOOP_COUNTER_RE)].map((match) => match[1]));
    for (const name of bindings) {
      if (isVagueName(name, loopCounters)) found.push(lineDeclaring(name, statementLines));
    }
  }
  return found;
}

export { namingSyntaxFor, scanVagueNameLines };
