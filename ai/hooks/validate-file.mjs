#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { allow, denyPreToolUse, readPayload } from "./hook-io.mjs";

const TEXT_EXTS = new Set([
  ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts",
  ".py", ".dart", ".md", ".txt", ".yml", ".yaml", ".toml", ".css", ".html",
  ".sh", ".env", ".xml", ".svg",
]);

const BIOME_EXTS = new Set([
  ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".css",
]);

const FIX_CTRL =
  "Remove the character (it usually comes from a bad copy-paste or a non-UTF-8 source), re-type the affected text, and save as UTF-8.";

const DOC_SIZE_CAPS = {
  "agents.md": 16384,
  "claude.md": 16384,
  // inject-routing.mjs prints this to stdout; Claude Code persists hook stdout over ~10000 bytes and injects only a 2KB preview.
  "routing.md": 9216,
};

const REVIEW_LADDER_PATH_SUFFIXES = [
  "skills/commit/SKILL.md",
  "skills/code-review/SKILL.md",
  "skills/qa-swarm/SKILL.md",
  "agents/finding-fixer.md",
  "workflows/qa-swarm.js",
];

function deny(filePath, diagnostic) {
  const reason = [
    `File-format guard blocked this write to ${path.basename(filePath)}.`,
    diagnostic.where ? `Where: ${diagnostic.where}` : null,
    `Why: ${diagnostic.why}`,
    diagnostic.fix ? `Fix: ${diagnostic.fix}` : null,
    "(Only syntax/format, invalid characters, and instruction-file size are gated here, not type or lint errors.)",
  ]
    .filter(Boolean)
    .join("\n");
  denyPreToolUse(reason);
}

function applyEdit(text, oldStr, newStr, replaceAll) {
  if (oldStr === undefined) return text;
  if (replaceAll) return text.split(oldStr).join(newStr ?? "");
  const i = text.indexOf(oldStr);
  if (i === -1) return text;
  return text.slice(0, i) + (newStr ?? "") + text.slice(i + oldStr.length);
}

function reconstruct(ti, filePath) {
  if (typeof ti.content === "string") return ti.content;
  if (!ti.edits && ti.old_string === undefined) return undefined;
  const orig = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (ti.edits) {
    return ti.edits.reduce((c, e) => applyEdit(c, e.old_string, e.new_string, e.replace_all), orig);
  }
  return applyEdit(orig, ti.old_string, ti.new_string, ti.replace_all);
}

function posOf(content, index) {
  let line = 1;
  let col = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 0x0a) {
      line++;
      col = 1;
      continue;
    }
    col++;
  }
  return { line, column: col };
}

function loc(line, column) {
  return `line ${line}, column ${column}`;
}

function charScanError(text, classify) {
  for (let i = 0; i < text.length; i++) {
    const hit = classify(text.charCodeAt(i));
    if (!hit) continue;
    const { line, column } = posOf(text, i);
    return { where: loc(line, column), ...hit };
  }
  return null;
}

function classifyControlChar(c) {
  if (c >= 0x20 && c < 0x7f) return null;
  const allowed = c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
  const bad = c === 0xfffd || (c <= 0x1f && !allowed) || (c >= 0x7f && c <= 0x9f);
  if (!bad) return null;
  if (c === 0x00) return { why: "contains a NUL byte (U+0000)", fix: FIX_CTRL };
  if (c === 0xfffd) {
    return {
      why: "contains the Unicode replacement character (U+FFFD), a sign of broken/mis-decoded encoding",
      fix: "The text was decoded with the wrong encoding. Re-read the source and re-type the affected text, then save as UTF-8.",
    };
  }
  const hex = c.toString(16).toUpperCase().padStart(4, "0");
  return { why: `contains a stray control character (U+${hex})`, fix: FIX_CTRL };
}

function controlCharError(content) {
  return charScanError(content, classifyControlChar);
}

function realPathOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function alwaysLoadedDocDirs() {
  const claudeDir = path.join(os.homedir(), ".claude");
  const dirs = [claudeDir];
  try {
    dirs.push(path.dirname(fs.realpathSync(path.join(claudeDir, "AGENTS.md"))));
  } catch {
    return dirs;
  }
  return dirs;
}

function holdsAlwaysLoadedDocs(dir) {
  const resolvedDir = realPathOrSelf(dir);
  for (const candidate of alwaysLoadedDocDirs()) {
    if (realPathOrSelf(candidate) === resolvedDir) return true;
  }
  return exists(path.join(dir, ".git"));
}

const GIT_PROBE_OPTS = { encoding: "utf8", timeout: 2000 };

function gitOutput(directory, gitArguments) {
  const gitProcess = spawnSync("git", ["-C", directory, ...gitArguments], GIT_PROBE_OPTS);
  if (gitProcess.error || gitProcess.status !== 0) return null;
  return String(gitProcess.stdout || "").trim();
}

function committedByteSize(filePath) {
  const resolvedPath = fs.realpathSync(filePath);
  const repositoryRoot = gitOutput(path.dirname(resolvedPath), ["rev-parse", "--show-toplevel"]);
  if (!repositoryRoot) return null;
  const pathInRepository = path.relative(repositoryRoot, resolvedPath).split(path.sep).join("/");
  const committedSizeText = gitOutput(repositoryRoot, ["cat-file", "-s", `HEAD:${pathInRepository}`]);
  if (!committedSizeText || !/^\d+$/.test(committedSizeText)) return null;
  return Number(committedSizeText);
}

function reviewLadderCeiling(filePath) {
  const committedSize = committedByteSize(filePath);
  if (committedSize !== null) return { bytes: committedSize, label: "committed" };
  return { bytes: fs.statSync(filePath).size, label: "prior" };
}

function reviewLadderGrowthError(filePath, content) {
  const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, "/"));
  const isReviewLadderFile = REVIEW_LADDER_PATH_SUFFIXES.some(
    (suffix) => normalizedPath === suffix || normalizedPath.endsWith(`/${suffix}`),
  );
  if (!isReviewLadderFile || !exists(filePath)) return null;
  let ceiling;
  try {
    ceiling = reviewLadderCeiling(filePath);
  } catch {
    return null;
  }
  const size = Buffer.byteLength(content, "utf8");
  if (size <= ceiling.bytes) return null;
  return {
    where: `${size} bytes, ${ceiling.label} ${ceiling.bytes}`,
    why: `${path.posix.basename(normalizedPath)} is a review-ladder file and may not grow; ceremony accumulates one reasonable rule at a time`,
    fix: "Retire an existing rule or step to make room for the new one, or drop the addition.",
  };
}

function docSizeError(filePath, content) {
  const ladderGrowthError = reviewLadderGrowthError(filePath, content);
  if (ladderGrowthError) return ladderGrowthError;
  const name = path.basename(filePath);
  const cap = DOC_SIZE_CAPS[name.toLowerCase()];
  if (!cap) return null;
  if (!holdsAlwaysLoadedDocs(path.dirname(path.resolve(filePath)))) return null;
  const size = Buffer.byteLength(content, "utf8");
  if (size <= cap) return null;
  let priorSize = 0;
  try {
    priorSize = exists(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return null;
  }
  if (size <= priorSize) return null;
  return {
    where: `${size} bytes, cap ${cap}`,
    why: `${name} is loaded into every session, and this write grows it past its size cap`,
    fix: "Cut existing lines to make room, move the material into a file loaded on demand, or drop it. Raise the entry in DOC_SIZE_CAPS only when the file has genuinely earned the extra budget.",
  };
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function biomeGlobalRoots() {
  const nodeDir = path.dirname(process.execPath);
  const roots = [];
  roots.push(path.resolve(nodeDir, "..", "lib", "node_modules"));
  if (process.env.npm_config_prefix) {
    roots.push(path.join(process.env.npm_config_prefix, "lib", "node_modules"));
  }
  if (process.env.HOME) {
    roots.push(path.join(process.env.HOME, ".npm-global", "lib", "node_modules"));
  }
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  return roots;
}

function biomeCmd() {
  if (exists(process.env.BIOME_BIN)) return [process.env.BIOME_BIN];
  for (const globalRoot of biomeGlobalRoots()) {
    const packageRoot = path.join(globalRoot, "@biomejs", "biome");
    const exe = path.join(
      packageRoot, "node_modules", "@biomejs",
      `cli-${process.platform}-${process.arch}`, "biome"
    );
    if (exists(exe)) return [exe];
    const shim = path.join(packageRoot, "bin", "biome");
    if (exists(shim)) return [process.execPath, shim];
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const direct = path.join(dir, "biome");
    if (exists(direct)) return [direct];
  }
  return null;
}

const SPAWN_OPTS = {
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 16 * 1024 * 1024,
};

function runStdin(bin, args, input) {
  return spawnSync(bin, args, { ...SPAWN_OPTS, input });
}

function validateJson(content) {
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    const m = /line (\d+) column (\d+)/.exec(e.message);
    return {
      where: m ? loc(m[1], m[2]) : null,
      why: "invalid JSON: " + e.message,
      fix: "Check for a trailing comma, an unquoted key, a missing or extra brace/bracket, or an unterminated string near the reported position.",
    };
  }
}

function harvestBiomeDiagnostic(content, filePath, cmd) {
  if (!cmd) return null;
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccfmt-"));
    const f = path.join(dir, path.basename(filePath));
    fs.writeFileSync(f, content);
    const [bin, ...pre] = cmd;
    const r = spawnSync(bin, [...pre, "check", "--reporter=json", "--max-diagnostics=10", f], SPAWN_OPTS);
    const out = String(r.stdout || "");
    const at = out.indexOf("{");
    if (at < 0) return null;
    const j = JSON.parse(out.slice(at));
    const d = (j.diagnostics || []).find((x) => x && x.category === "parse");
    if (!d) return null;
    const start = d.location && d.location.start;
    const where = start ? loc(start.line, start.column) : null;
    const why = typeof d.message === "string" ? d.message : String(d.message || "parse error");
    let fix = null;
    for (const a of d.advices || []) {
      const t = a && typeof a.text === "string" ? a.text.trim() : null;
      if (t && t !== why) {
        fix = t;
        break;
      }
    }
    return { where, why: why.replace(/\s+$/, ""), fix };
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function validateWithBiome(content, ext, filePath) {
  const cmd = biomeCmd();
  const jsonFallback = () => (ext === ".json" ? validateJson(content) : null);
  if (!cmd) return jsonFallback();
  const [bin, ...pre] = cmd;
  const r = runStdin(bin, [...pre, "format", `--stdin-file-path=${path.basename(filePath)}`], content);
  if (r.error) return jsonFallback();
  if (r.status === 0) return null;
  // A project biome.json can disable the formatter outright (formatter.enabled=false).
  // Biome then exits 1 ("formatter is currently disabled") WITHOUT parsing, which is
  // not a syntax verdict: fall back / fail open, never deny.
  const out = [r.stderr || "", r.stdout || ""].join(" ");
  if (out.includes("formatter is currently disabled")) return jsonFallback();
  const harvested = harvestBiomeDiagnostic(content, filePath, cmd);
  if (harvested) return harvested;
  const label = ext === ".json" || ext === ".jsonc" ? "JSON" : ext.slice(1).toUpperCase();
  return {
    where: null,
    why: `invalid ${label} syntax (the file would not parse)`,
    fix: "Check near your last edit for an unbalanced bracket, brace, parenthesis, quote, or a stray/missing comma.",
  };
}

// Most distros ship only `python3`, so the PATH scan precedes the bare `python` fallback.
function pythonBin() {
  if (exists(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const direct = path.join(dir, "python3");
    if (exists(direct)) return direct;
  }
  return "python";
}

function validatePython(content) {
  const r = runStdin(pythonBin(), ["-m", "ruff", "format", "--stdin-filename", "f.py", "-"], content);
  if (r.error || r.status === 0) return null;
  const err = (r.stderr || r.stdout || "").trim();
  // python present but ruff not installed: engine absent, not a parse failure.
  // Fail open per the decision-engine contract (a missing engine must never deny).
  if (/No module named ['"]?ruff/.test(err)) return null;
  const m = /Failed to parse [^\s:]*:(\d+):(\d+):\s*(.*)/.exec(err);
  if (m) {
    return {
      where: loc(m[1], m[2]),
      why: "invalid Python: " + m[3].trim(),
      fix: "Check for a missing parenthesis, colon, or comma, or a bad indentation near the reported position.",
    };
  }
  return {
    where: null,
    why: "invalid Python: " + (err.split("\n").pop() || "parse error"),
    fix: "Check for a syntax error near your last edit.",
  };
}

// Flutter keeps its real dart under `cache/dart-sdk/bin`; null here means fail open for .dart.
function dartBin() {
  if (exists(process.env.DART_BIN)) return process.env.DART_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const direct = path.join(dir, "dart");
    if (exists(direct)) return direct;
    const flutter = path.join(dir, "cache", "dart-sdk", "bin", "dart");
    if (exists(flutter)) return flutter;
  }
  return null;
}

function validateDart(content) {
  const bin = dartBin();
  if (!bin) return null;
  const r = runStdin(bin, ["format", "--output=none", "--stdin-name=main.dart"], content);
  if (r.error || r.status !== 65) return null;
  const out = (r.stderr || r.stdout || "").trim();
  const m = /line (\d+), column (\d+) of [^:]*:\s*(.*)/.exec(out);
  if (m) {
    return {
      where: loc(m[1], m[2]),
      why: "invalid Dart: " + m[3].trim(),
      fix: "Check for a missing semicolon, brace, parenthesis, or bracket near the reported position.",
    };
  }
  return {
    where: null,
    why: "invalid Dart (the file would not parse)",
    fix: "Check near your last edit for an unbalanced brace, parenthesis, bracket, or a missing semicolon.",
  };
}

function validate(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const size = docSizeError(filePath, content);
  if (size) return size;
  if (TEXT_EXTS.has(ext)) {
    const cc = controlCharError(content);
    if (cc) return cc;
  }
  if (ext === ".py") return validatePython(content);
  if (ext === ".dart") return validateDart(content);
  if (BIOME_EXTS.has(ext)) return validateWithBiome(content, ext, filePath);
  return null;
}

try {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  const toolInput = payload.tool_input || {};
  const filePath = toolInput.file_path || toolInput.filePath;
  if (!filePath) allow();

  const content = reconstruct(toolInput, filePath);
  if (content === undefined) allow();

  const diagnostic = validate(filePath, content);
  if (diagnostic) deny(filePath, diagnostic);
  allow();
} catch {
  allow();
}
