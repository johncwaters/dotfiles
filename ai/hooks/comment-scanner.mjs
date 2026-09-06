import path from "node:path";

const SLASH_BLOCK = {
  line: "//",
  blockOpen: "/*",
  blockClose: "*/",
  stringTracker: makeTemplateLiteralTracker,
};
const BLOCK_ONLY = { line: null, blockOpen: "/*", blockClose: "*/" };
const HASH = { line: "#", blockOpen: null, blockClose: null };
const PYTHON = { ...HASH, stringTracker: makeTripleQuoteTracker };
const SHELL = { ...HASH, stringTracker: makeHeredocTracker };
const DASH = { line: "--", blockOpen: null, blockClose: null };

const SYNTAX_BY_EXT = new Map([
  ...[".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
    ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".go", ".rs",
    ".swift", ".kt", ".kts", ".scala", ".dart", ".php", ".proto",
    ".groovy", ".sol"].map((ext) => [ext, SLASH_BLOCK]),
  ...[".css", ".scss", ".less"].map((ext) => [ext, BLOCK_ONLY]),
  ...[".rb", ".fish", ".pl", ".pm", ".r",
    ".jl", ".tcl", ".nix", ".tf", ".cmake",
    ".ps1", ".ex", ".exs"].map((ext) => [ext, HASH]),
  ...[".py"].map((ext) => [ext, PYTHON]),
  ...[".sh", ".bash", ".zsh"].map((ext) => [ext, SHELL]),
  ...[".sql", ".lua", ".hs", ".elm"].map((ext) => [ext, DASH]),
]);

const JSDOC_TAG_RE =
  /^[ \t]*(?:\/\*\*[ \t]*)?(?:\*[ \t]*)?@(param|returns?|type|typedef|template|property|prop|callback|this|typeParam|satisfies|import|deprecated|override|internal|public|private|protected|readonly)\b/m;
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

function stripQuotedSpans(line, preservedTokens) {
  let outsideQuotes = "";
  let openDelimiter = null;
  let index = 0;
  while (index < line.length) {
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
      if (character === openDelimiter) openDelimiter = null;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      openDelimiter = character;
      index++;
      continue;
    }
    outsideQuotes += character;
    index++;
  }
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

function isExemptDocLine(trimmed, insideDocBlock) {
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
      if (!isExemptDocLine(trimmed, insideDocBlock)) found.push(trimmed);
      if (syntax.blockClose && trimmed.includes(syntax.blockClose)) inBlock = false;
      continue;
    }
    if (i === 0 && trimmed.startsWith("#!")) continue;
    if (syntax.blockOpen && trimmed.startsWith(syntax.blockOpen)) {
      const opensDocBlock = trimmed.startsWith("/**");
      if (!isExemptDocLine(trimmed, opensDocBlock)) found.push(trimmed);
      if (!trimmed.includes(syntax.blockClose)) {
        inBlock = true;
        insideDocBlock = opensDocBlock;
      }
      continue;
    }
    if (syntax.line && trimmed.startsWith(syntax.line)) {
      found.push(trimmed);
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

export { commentLinesOnlyInAfter, scanCommentLines, syntaxFor };
