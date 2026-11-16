import path from "node:path";

const SLASH_BLOCK = {
  line: "//",
  blockOpen: "/*",
  blockClose: "*/",
  stringTracker: makeTemplateLiteralTracker,
};
const JS_TS = { ...SLASH_BLOCK, allowsToolPragmas: true };
const BLOCK_ONLY = { line: null, blockOpen: "/*", blockClose: "*/" };
const HASH = { line: "#", blockOpen: null, blockClose: null };
const PYTHON = { ...HASH, stringTracker: makeTripleQuoteTracker };
const SHELL = { ...HASH, stringTracker: makeHeredocTracker };
const DASH = { line: "--", blockOpen: null, blockClose: null };

const SYNTAX_BY_EXT = new Map([
  ...[".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].map((ext) => [ext, JS_TS]),
  ...[".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".go", ".rs",
    ".swift", ".kt", ".kts", ".scala", ".dart", ".php", ".proto",
    ".groovy", ".sol"].map((ext) => [ext, SLASH_BLOCK]),
  ...[".css", ".scss", ".less"].map((ext) => [ext, BLOCK_ONLY]),
  ...[".rb", ".fish", ".pl", ".pm", ".r",
    ".jl", ".tcl", ".nix", ".tf", ".cmake",
    ".ex", ".exs"].map((ext) => [ext, HASH]),
  ...[".py"].map((ext) => [ext, PYTHON]),
  ...[".sh", ".bash", ".zsh"].map((ext) => [ext, SHELL]),
  ...[".sql", ".lua", ".hs", ".elm"].map((ext) => [ext, DASH]),
]);

const JSDOC_TAG_RE =
  /^[ \t]*(?:\/\*\*[ \t]*)?(?:\*[ \t]*)?@(param|returns?|type|typedef|template|property|prop|callback|this|typeParam|satisfies|import|deprecated|override|internal|public|private|protected|readonly)\b/m;
const TOOL_PRAGMA_RE =
  /^(?<opener>\/\/|\/\*\*?|\*)[ \t]*@(?<name>[\w-]+)[ \t]+(?<value>[^\s*]+)[ \t]*(?:\*\/)?$/;
const MAX_TOOL_PRAGMA_VALUE_LENGTH = 64;
const PRAGMA_WORDS = "[a-z0-9][a-z0-9_]*(?:[.-][a-z0-9_]+){0,2}";
const ENVIRONMENT_VALUE_RE =
  /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+){0,2}|(?:\.{1,2}\/)+\w+(?:[.-]\w+){0,3}(?:\/\w+(?:[.-]\w+){0,3})*)$/;
const JSX_FACTORY_VALUE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/;
const PACKAGE_SPECIFIER_RE = new RegExp(`^(?:@${PRAGMA_WORDS}\\/)?${PRAGMA_WORDS}(?:\\/${PRAGMA_WORDS})?$`);
const TOOL_PRAGMA_VALUE_RE_BY_NAME = new Map([
  ["vitest-environment", ENVIRONMENT_VALUE_RE],
  ["jest-environment", ENVIRONMENT_VALUE_RE],
  ["jsx", JSX_FACTORY_VALUE_RE],
  ["jsxFrag", JSX_FACTORY_VALUE_RE],
  ["jsxImportSource", PACKAGE_SPECIFIER_RE],
  ["jsxRuntime", /^(?:classic|automatic)$/],
]);
const HEREDOC_OPEN_RE = /^<<-?(?!<)[ \t]*(['"]?)\\?([A-Za-z_][A-Za-z0-9_]*)\1/;
const TRIPLE_QUOTES = ['"""', "'''"];

function makeNoStringRegions() {
  return { startsInsideString: () => false, advance: () => {} };
}

function syntaxFor(filePath) {
  return SYNTAX_BY_EXT.get(path.extname(String(filePath)).toLowerCase()) ?? null;
}

function countOccurrences(line, needle) {
  return line.split(needle).length - 1;
}

function stripQuotedSpans(line, preservedTokens, state = {}, syntax = null) {
  let outsideQuotes = "";
  let openDelimiter = state.openDelimiter ?? null;
  const quoteDelimiters = syntax?.stringTracker === makeTripleQuoteTracker
    ? [...TRIPLE_QUOTES, '"', "'"]
    : ['"', "'", "`"];
  let index = 0;
  while (index < line.length) {
    if (state.isInsideBlock) {
      const closeIndex = line.indexOf(syntax.blockClose, index);
      if (closeIndex < 0) break;
      state.isInsideBlock = false;
      index = closeIndex + syntax.blockClose.length;
      outsideQuotes += " ";
      continue;
    }
    const character = line[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    const preserved = preservedTokens.find((token) => line.startsWith(token, index));
    if (!openDelimiter && preserved) {
      outsideQuotes += preserved;
      openDelimiter = preserved;
      index += preserved.length;
      continue;
    }
    if (openDelimiter) {
      if (preserved === openDelimiter) {
        outsideQuotes += preserved;
        openDelimiter = null;
        index += preserved.length;
        continue;
      }
      if (line.startsWith(openDelimiter, index)) {
        index += openDelimiter.length;
        openDelimiter = null;
        continue;
      }
      index++;
      continue;
    }
    if (syntax?.line && line.startsWith(syntax.line, index)) {
      outsideQuotes += line.slice(index);
      break;
    }
    if (syntax?.blockOpen && line.startsWith(syntax.blockOpen, index)) {
      state.isInsideBlock = true;
      index += syntax.blockOpen.length;
      outsideQuotes += " ";
      continue;
    }
    const openingQuote = (syntax ? quoteDelimiters : ['"', "'"])
      .find((delimiter) => line.startsWith(delimiter, index));
    if (openingQuote) {
      openDelimiter = openingQuote;
      index += openingQuote.length;
      if (syntax) outsideQuotes += " ";
      continue;
    }
    outsideQuotes += character;
    index++;
  }
  const isPlainQuote = openDelimiter === '"' || openDelimiter === "'";
  const allowsMultilinePlainQuotes = syntax?.stringTracker === makeHeredocTracker;
  state.openDelimiter = isPlainQuote && !allowsMultilinePlainQuotes ? null : openDelimiter;
  return outsideQuotes;
}

function countUnescapedTokens(line, token) {
  let tokens = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\") {
      index++;
      continue;
    }
    if (!line.startsWith(token, index)) continue;
    tokens++;
    index += token.length - 1;
  }
  return tokens;
}

function startsCommentAt(line, index, tail) {
  if (!line.startsWith(tail.marker, index)) return false;
  if (!tail.needsSpaceBefore) return true;
  return index === 0 || /[ \t]/.test(line[index - 1]);
}

function dropCommentTail(line, tail) {
  let outsideComment = "";
  let openQuote = null;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === "\\") {
      outsideComment += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (openQuote) {
      outsideComment += character;
      if (character === openQuote) openQuote = null;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      openQuote = character;
      outsideComment += character;
      index++;
      continue;
    }
    if (startsCommentAt(line, index, tail)) return outsideComment;
    if (tail.blockOpen && line.startsWith(tail.blockOpen, index)) {
      const closeAt = line.indexOf(tail.blockClose, index + tail.blockOpen.length);
      if (closeAt < 0) return outsideComment;
      index = closeAt + tail.blockClose.length;
      continue;
    }
    outsideComment += character;
    index++;
  }
  return outsideComment;
}

const SLASH_TAIL = { marker: "//", needsSpaceBefore: false, blockOpen: "/*", blockClose: "*/" };
const HASH_TAIL = { marker: "#", needsSpaceBefore: true, blockOpen: null, blockClose: null };

function makeTemplateLiteralTracker() {
  let insideTemplate = false;
  return {
    startsInsideString: () => insideTemplate,
    advance(line) {
      const scannable = insideTemplate
        ? line
        : dropCommentTail(stripQuotedSpans(line, ["`"]), SLASH_TAIL);
      if (countUnescapedTokens(scannable, "`") % 2 === 1) insideTemplate = !insideTemplate;
    },
  };
}

function makeTripleQuoteTracker() {
  let openQuote = null;
  return {
    startsInsideString: () => openQuote !== null,
    advance(line) {
      if (openQuote) {
        if (countUnescapedTokens(line, openQuote) % 2 === 1) openQuote = null;
        return;
      }
      const scannable = stripQuotedSpans(dropCommentTail(line, HASH_TAIL), TRIPLE_QUOTES);
      const opening = TRIPLE_QUOTES.find((quote) => countOccurrences(scannable, quote) % 2 === 1);
      if (opening) openQuote = opening;
    },
  };
}

function findHeredocDelimiters(line) {
  const delimiters = [];
  let openQuote = null;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (openQuote) {
      if (character === openQuote) openQuote = null;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      openQuote = character;
      index++;
      continue;
    }
    if (character !== "<") {
      index++;
      continue;
    }
    const opening = HEREDOC_OPEN_RE.exec(line.slice(index));
    if (opening) {
      delimiters.push(opening[2]);
      index += opening[0].length;
      continue;
    }
    while (index < line.length && line[index] === "<") index++;
  }
  return delimiters;
}

function makeHeredocTracker() {
  const openDelimiters = [];
  return {
    startsInsideString: () => openDelimiters.length > 0,
    advance(line) {
      if (openDelimiters.length > 0) {
        if (line.trim() === openDelimiters[0]) openDelimiters.shift();
        return;
      }
      openDelimiters.push(...findHeredocDelimiters(dropCommentTail(line, HASH_TAIL)));
    },
  };
}

function isToolPragma(trimmed, insideDocBlock) {
  const pragma = TOOL_PRAGMA_RE.exec(trimmed);
  if (!pragma) return false;
  if (pragma.groups.opener === "*" && !insideDocBlock) return false;
  const valueGrammar = TOOL_PRAGMA_VALUE_RE_BY_NAME.get(pragma.groups.name);
  if (!valueGrammar) return false;
  return pragma.groups.value.length <= MAX_TOOL_PRAGMA_VALUE_LENGTH && valueGrammar.test(pragma.groups.value);
}

function isExemptDocLine(trimmed, insideDocBlock, syntax) {
  if (syntax.allowsToolPragmas && isToolPragma(trimmed, insideDocBlock)) return true;
  if (!insideDocBlock) return false;
  if (trimmed === "/**" || trimmed === "*/") return true;
  return JSDOC_TAG_RE.test(trimmed);
}

function scanCommentLines(content, syntax) {
  const lines = String(content).split("\n");
  const strings = (syntax.stringTracker ?? makeNoStringRegions)();
  const found = [];
  let inBlock = false;
  let insideDocBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (strings.startsInsideString()) {
      strings.advance(line);
      continue;
    }
    if (inBlock) {
      if (!isExemptDocLine(trimmed, insideDocBlock, syntax)) found.push(trimmed);
      if (syntax.blockClose && trimmed.includes(syntax.blockClose)) inBlock = false;
      continue;
    }
    if (i === 0 && trimmed.startsWith("#!")) continue;
    if (syntax.blockOpen && trimmed.startsWith(syntax.blockOpen)) {
      const opensDocBlock = trimmed.startsWith("/**");
      if (!isExemptDocLine(trimmed, opensDocBlock, syntax)) found.push(trimmed);
      if (!trimmed.includes(syntax.blockClose)) {
        inBlock = true;
        insideDocBlock = opensDocBlock;
      }
      continue;
    }
    if (syntax.line && trimmed.startsWith(syntax.line)) {
      if (!isExemptDocLine(trimmed, false, syntax)) found.push(trimmed);
      continue;
    }
    strings.advance(line);
  }
  return found;
}

function commentLinesOnlyInAfter(beforeLines, afterLines) {
  const unmatchedBefore = new Map();
  for (const line of beforeLines) {
    unmatchedBefore.set(line, (unmatchedBefore.get(line) ?? 0) + 1);
  }
  const addedLines = [];
  for (const line of afterLines) {
    const remaining = unmatchedBefore.get(line) ?? 0;
    if (remaining > 0) {
      unmatchedBefore.set(line, remaining - 1);
      continue;
    }
    addedLines.push(line);
  }
  return addedLines;
}

const STATEMENT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".go", ".rs",
  ".swift", ".kt", ".kts", ".scala", ".dart", ".php", ".groovy",
  ".py", ".sh", ".bash", ".zsh", ".rb", ".lua", ".pl", ".pm",
]);

function elseSyntaxFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!STATEMENT_EXTENSIONS.has(extension)) return null;
  return { ...syntaxFor(filePath), statementLanguage: extension };
}

function isExemptIndentedElse(code, language, openersByIndent) {
  if (language !== ".py" && language !== ".rb") return false;
  const indentation = /^\s*/.exec(code)[0].replaceAll("\t", "        ").length;
  for (const depth of openersByIndent.keys()) {
    if (depth > indentation) openersByIndent.delete(depth);
  }
  const opener = openersByIndent.get(indentation);
  const trimmed = code.trim();
  if (language === ".py") {
    const isElse = /^else\s*:/.test(trimmed);
    const opening = /^(?:async\s+)?(if|elif|for|while|try|except)\b/.exec(trimmed);
    if (isElse) openersByIndent.delete(indentation);
    if (opening) openersByIndent.set(indentation, opening[1]);
    return isElse && ["for", "while", "try", "except"].includes(opener);
  }
  if (/^end\b/.test(trimmed)) {
    openersByIndent.delete(indentation);
    return false;
  }
  const opening = /^(begin|rescue|if|unless|case|while|until|for|def|class|module)\b/.exec(trimmed);
  if (opening) openersByIndent.set(indentation, opening[1]);
  return /^else\b/.test(trimmed) && opener === "rescue";
}

const IF_EXPRESSION_LANGUAGES = new Set([".kt", ".kts", ".scala"]);
const IF_IN_EXPRESSION_POSITION_RE = /(?:=|\breturn|\(|,|->)\s*if\b/;

function statementElsesIn(code, language) {
  if (language === ".py") return code.match(/^\s*(?:else\s*:|elif\b)/g) ?? [];
  if (IF_EXPRESSION_LANGUAGES.has(language) && IF_IN_EXPRESSION_POSITION_RE.test(code)) return [];
  return code.match(/\b(?:else|elif|elsif)\b/g) ?? [];
}

function* codeLinesOf(content, syntax) {
  const strings = (syntax.stringTracker ?? makeNoStringRegions)();
  const state = {};
  const tail = { marker: syntax.line ?? "\u0000", needsSpaceBefore: false };
  for (const line of String(content).split("\n")) {
    if (strings.startsInsideString()) {
      strings.advance(line);
      if (!strings.startsInsideString()) state.openDelimiter = null;
      continue;
    }
    const wasInsideBlock = state.isInsideBlock;
    const code = dropCommentTail(stripQuotedSpans(line, [], state, syntax), tail);
    if (!wasInsideBlock && !state.isInsideBlock) strings.advance(line);
    if (code.trim()) yield { line, code };
  }
}

function scanElseLines(content, syntax) {
  const openersByIndent = new Map();
  const found = [];
  for (const { line, code: rawCode } of codeLinesOf(content, syntax)) {
    if (isExemptIndentedElse(rawCode, syntax.statementLanguage, openersByIndent)) continue;
    const code = syntax.statementLanguage === ".rs"
      ? rawCode.replace(/^(\s*let\b[^;]*?=[^;]*?)\belse(?=\s*\{)/, "$1")
      : rawCode;
    found.push(...Array.from(statementElsesIn(code, syntax.statementLanguage), () => line.trim()));
  }
  return found;
}

const EFFECT_HOOK_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);
const EFFECT_HOOK_RE = /\b(?:React\.)?use(?:Isomorphic)?(?:Layout)?Effect\s*(?:\(|\bas\b)/g;

function useEffectSyntaxFor(filePath) {
  if (!EFFECT_HOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  return syntaxFor(filePath);
}

function scanUseEffectLines(content, syntax) {
  const found = [];
  for (const line of String(content).split("\n")) {
    const tail = { marker: syntax.line, needsSpaceBefore: false };
    const code = dropCommentTail(stripQuotedSpans(line, [], {}, syntax), tail);
    found.push(...Array.from(code.matchAll(EFFECT_HOOK_RE), () => line.trim()));
  }
  return found;
}

export {
  commentLinesOnlyInAfter, scanCommentLines, syntaxFor, elseSyntaxFor, scanElseLines,
  useEffectSyntaxFor, scanUseEffectLines,
};
