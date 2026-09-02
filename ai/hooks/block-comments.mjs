#!/usr/bin/env node
/**
 * PreToolUse guard for Write / Edit / MultiEdit that DENIES a tool call which
 * would add net-new comment lines to a code file. Seeded onto a fresh machine
 * from glissa/config.example.json (config.json `hooks`) and edited per-session
 * through the Glissa Hooks tab, NOT through ~/.claude/settings.json, so it
 * applies only to Glissa-spawned agent sessions.
 *
 * What counts: full lines that are comments (line markers `//`, `#`, `--`, and
 * block comments opening at line start) outside string regions (JS template
 * literals, Python triple-quoted strings, shell heredoc bodies), whose openers are
 * read only from the code before a trailing comment. What is exempt: the shebang
 * line, and inside a `/**` block its bare delimiters and `@tag` lines (type
 * machinery the typecheck gates depend on); its prose lines still count. Accepted
 * under-blocks: trailing comments after code, a `#` glued to the word before it
 * (`url#frag`), a backtick inside a JS regex literal, and a shell left shift by a
 * bare name (`$((1 << width))`), which still reads as a heredoc opener.
 *
 * The decision compares counts, not absolutes: a Write is judged against the file
 * currently on disk, an Edit against that same file with its edits applied, and
 * only against its own old_string when the file is absent or the fragment does
 * not occur in it. So deleting, moving, or rewriting existing comments always
 * passes. Only growth denies, and the reason quotes only lines the call itself
 * supplied, falling back to a bare count when the denied line came from disk.
 *
 * Fail open (shared rule of this directory): any error, unreadable payload, or
 * unknown file type MUST allow. Node built-ins only, synchronous, pure ASCII.
 */

import fs from "node:fs";
import path from "node:path";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";

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

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.slice(0, 100)}`);
  const why =
    shown.length > 0
      ? [`Why: it adds ${addedCount} net-new comment line(s):`, ...shown]
      : [`Why: it adds ${addedCount} net-new comment line(s).`];
  denyPreToolUse([
    `No-comments guard blocked this write to ${path.basename(String(filePath))}.`,
    ...why,
    "Fix: delete the comment(s) and put the intent into names and structure instead.",
    "JSDoc @tag lines with their /** and */ delimiters, and the shebang line, are exempt; rewriting or deleting existing comments always passes.",
    "If a why-comment is genuinely load-bearing (external anchor, cross-file invariant), ask the operator to add it themselves.",
  ].join("\n"));
}

function readBaseline(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (readError) {
    if (readError?.code === "ENOENT") return "";
    return null;
  }
}

function compareDocuments(before, after, syntax) {
  const beforeComments = scanCommentLines(before, syntax);
  const afterComments = scanCommentLines(after, syntax);
  return {
    added: afterComments.length - beforeComments.length,
    samples: commentLinesOnlyInAfter(beforeComments, afterComments),
  };
}

function judgeWrite(toolInput, syntax) {
  const before = readBaseline(toolInput.file_path);
  if (before === null) return null;
  const content = typeof toolInput.content === "string" ? toolInput.content : "";
  return compareDocuments(before, content, syntax);
}

function editsOf(toolInput) {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  return edits.filter((edit) => edit && typeof edit === "object");
}

function applyEdit(document, edit) {
  const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
  const newString = typeof edit.new_string === "string" ? edit.new_string : "";
  if (oldString === "") return null;
  if (edit.replace_all === true) return document.split(oldString).join(newString);
  const at = document.indexOf(oldString);
  if (at < 0) return null;
  return document.slice(0, at) + newString + document.slice(at + oldString.length);
}

function applyEdits(document, edits) {
  let applied = document;
  for (const edit of edits) {
    const next = applyEdit(applied, edit);
    if (next === null) return null;
    applied = next;
  }
  return applied;
}

function judgeFragments(edits, syntax) {
  let added = 0;
  const samples = [];
  for (const edit of edits) {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : "";
    const fragment = compareDocuments(oldString, newString, syntax);
    added += fragment.added;
    samples.push(...fragment.samples);
  }
  return { added, samples };
}

function samplesSuppliedByCall(toolInput, samples) {
  const supplied = [
    typeof toolInput.content === "string" ? toolInput.content : "",
    ...editsOf(toolInput).map((edit) =>
      typeof edit.new_string === "string" ? edit.new_string : "",
    ),
  ].join("\n");
  return samples.filter((line) => supplied.includes(line));
}

function judgeEdits(toolInput, syntax) {
  const edits = editsOf(toolInput);
  const baseline = readBaseline(toolInput.file_path);
  if (baseline === null) return null;
  const edited = baseline === "" ? null : applyEdits(baseline, edits);
  if (edited === null) return judgeFragments(edits, syntax);
  return compareDocuments(baseline, edited, syntax);
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const toolName = payload.tool_name;
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (typeof toolInput.file_path !== "string") allow();
  const syntax = syntaxFor(toolInput.file_path);
  if (!syntax) allow();
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") allow();
  const judge = toolName === "Write" ? judgeWrite : judgeEdits;
  const judgement = judge(toolInput, syntax);
  if (judgement && judgement.added > 0) {
    deny(toolInput.file_path, judgement.added, samplesSuppliedByCall(toolInput, judgement.samples));
  }
  allow();
} catch {
  allow();
}
