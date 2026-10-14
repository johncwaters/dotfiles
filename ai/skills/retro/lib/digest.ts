import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export type IncidentKind =
  | "correction"
  | "interrupt"
  | "permission-denial"
  | "hook-denial"
  | "tool-error"
  | "repeated-failure"
  | "review-rework"
  | "compaction"
  | "costly-subagent"
  | "oversized-result"
  | "revert";

export type Incident = {
  kind: IncidentKind;
  line: number;
  excerpt: string;
  toolName?: string;
  count?: number;
  explicit?: boolean;
  commit?: string;
};

export type SessionDigest = {
  sessionId: string;
  transcriptPath: string;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lineCount: number;
  malformedLineCount: number;
  promptCount: number;
  counts: Record<IncidentKind, number>;
  incidents: Incident[];
};

export type DigestOptions = { includeGit?: boolean };

type JsonObject = Record<string, unknown>;
type ToolUse = { name: string; command: string };

function asObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    const textBlock = asObject(block);
    return textBlock?.type === "text" ? [asText(textBlock.text)] : [];
  }).join("\n");
}

const MACHINE_TURN_ORIGINS = new Set(["task_notification", "scheduled", "system", "peer"]);

function isMachinePrompt(entry: JsonObject): boolean {
  const originKind = asObject(entry.origin)?.kind;
  if (typeof originKind === "string" && originKind !== "human") return true;
  if (entry.promptSource === "system" || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return true;
  return MACHINE_TURN_ORIGINS.has(asText(entry.turnOrigin));
}

const OVERSIZED_OUTPUT_MARKERS = ["<persisted-output>", "Output too large (", "exceeds maximum allowed tokens"];

function isOversizedResult(text: string): boolean {
  return text.length >= 60000 || OVERSIZED_OUTPUT_MARKERS.some((marker) => text.includes(marker));
}

function excerpt(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 160);
}

function readObject(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function isSessionFile(filePath: string): boolean {
  if (!filePath.endsWith(".jsonl")) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function projectDirectories(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "subagents")
      .map((entry) => join(projectsDir, entry.name)).sort();
  } catch {
    return [];
  }
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function findTranscript(sessionIdOrPath: string, projectsDir: string): string | null {
  if (isSessionFile(sessionIdOrPath)) return sessionIdOrPath;
  if (!sessionIdOrPath || /[/\\]/.test(sessionIdOrPath)) return null;
  for (const directory of projectDirectories(projectsDir)) {
    const transcriptPath = join(directory, `${sessionIdOrPath}.jsonl`);
    if (isSessionFile(transcriptPath)) return transcriptPath;
  }
  return null;
}

export function listTranscriptsSince(projectsDir: string, sinceDate: Date | string): string[] {
  const sinceMs = new Date(sinceDate).getTime();
  if (!Number.isFinite(sinceMs)) return [];
  const transcripts: { path: string; modifiedAtMs: number }[] = [];
  for (const directory of projectDirectories(projectsDir)) {
    let filenames: string[];
    try {
      filenames = readdirSync(directory);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      if (!filename.endsWith(".jsonl")) continue;
      const transcriptPath = join(directory, filename);
      try {
        const metadata = statSync(transcriptPath);
        if (!metadata.isFile() || metadata.mtimeMs < sinceMs) continue;
        transcripts.push({ path: transcriptPath, modifiedAtMs: metadata.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return transcripts.sort((first, second) =>
    first.modifiedAtMs - second.modifiedAtMs || first.path.localeCompare(second.path),
  ).map((transcript) => transcript.path);
}

function appendGitIncidents(digest: SessionDigest): void {
  if (!digest.cwd || !digest.startedAt || !digest.endedAt) return;
  const gitProcess = readGitLog(digest.cwd, digest.startedAt, digest.endedAt);
  if (!gitProcess) return;
  if (gitProcess.status !== 0 || gitProcess.error) return;
  for (const commitLine of gitProcess.stdout.split("\n")) {
    const separator = commitLine.indexOf("\t");
    if (separator < 0 || !/^(Revert |fixup!|squash!)/.test(commitLine.slice(separator + 1))) continue;
    digest.incidents.push({ kind: "revert", line: 0, excerpt: "", commit: commitLine.slice(0, 7) });
    digest.counts.revert += 1;
  }
}

function readGitLog(cwd: string, startedAt: string, endedAt: string): SpawnSyncReturns<string> | null {
  try {
    return spawnSync("git", [
      "-C", cwd, "log", `--since=${startedAt}`, `--until=${endedAt}`, "--format=%H%x09%s",
    ], { encoding: "utf8", timeout: 1000 });
  } catch {
    return null;
  }
}

export async function digestTranscript(
  transcriptPath: string,
  options: DigestOptions = {},
): Promise<SessionDigest> {
  const digest: SessionDigest = {
    sessionId: basename(transcriptPath, ".jsonl"), transcriptPath,
    cwd: null, gitBranch: null, startedAt: null, endedAt: null,
    lineCount: 0, malformedLineCount: 0, promptCount: 0,
    counts: {
      correction: 0, interrupt: 0, "permission-denial": 0, "hook-denial": 0,
      "tool-error": 0, "repeated-failure": 0, "review-rework": 0, compaction: 0,
      "costly-subagent": 0, "oversized-result": 0, revert: 0,
    },
    incidents: [],
  };
  const toolsById = new Map<string, ToolUse>();
  const failuresByCommand = new Map<string, { count: number; incident?: Incident }>();
  let reviewCount = 0;
  let hasPendingInterrupt = false;

  function addIncident(kind: IncidentKind, text: string, fields: Partial<Incident> = {}): Incident {
    const incident = { kind, line: digest.lineCount, excerpt: excerpt(text), ...fields };
    digest.incidents.push(incident);
    digest.counts[kind] += 1;
    return incident;
  }

  function recordPrompt(text: string, entry: JsonObject): void {
    const trimmed = text.trim();
    if (trimmed.startsWith("[Request interrupted by user")) {
      addIncident("interrupt", text);
      hasPendingInterrupt = true;
      return;
    }
    if (entry.isMeta === true || isMachinePrompt(entry) || !trimmed || /^(<command-name>|<local-command-stdout>|<command-message>|<system-reminder>|<task-notification>|Caveat:|Base directory for this skill:)/.test(trimmed)) return;
    const ownWords = trimmed.replace(/<pasted_content\b[\s\S]*?<\/pasted_content>/g, " ").trim().toLowerCase();
    const isRedirect = /^(no|nope|stop|wait|wrong|actually|instead|undo|revert)\b|don't|do not|not what i|why did you|that's wrong|you should have|i said|i told you/.test(ownWords);
    if (hasPendingInterrupt || (digest.promptCount > 0 && isRedirect)) {
      addIncident("correction", text, { explicit: true });
    }
    digest.promptCount += 1;
    hasPendingInterrupt = false;
  }

  function recordToolUse(block: JsonObject): void {
    const name = asText(block.name);
    const input = asObject(block.input);
    const command = asText(input?.command).replace(/\s+/g, " ").trim();
    if (typeof block.id === "string") toolsById.set(block.id, { name, command });
    if (name === "Agent" && input?.subagent_type === "finding-fixer") {
      addIncident("review-rework", asText(input.subagent_type), { toolName: name });
    }
    if (name !== "Skill" || input?.skill !== "code-review") return;
    reviewCount += 1;
    if (reviewCount > 1) addIncident("review-rework", "code-review", { toolName: name });
  }

  function recordToolResult(block: JsonObject, toolUseResult: JsonObject | null): void {
    const text = contentText(block.content);
    const tool = toolsById.get(asText(block.tool_use_id));
    const toolFields = tool?.name ? { toolName: tool.name } : {};
    if (isOversizedResult(text)) addIncident("oversized-result", text, toolFields);
    if ((tool?.name === "Agent" || tool?.name === "Task" || typeof toolUseResult?.agentType === "string") && typeof toolUseResult?.totalTokens === "number" && toolUseResult.totalTokens >= 150000) {
      addIncident("costly-subagent", text, { ...toolFields, count: toolUseResult.totalTokens });
    }
    if (block.is_error !== true) return;
    const trimmed = text.trim();
    const hookLabel = trimmed.match(/^([^\s<>]+) hook error/)?.[1];
    const isPermissionDenial = /^(Permission to use .* has been denied|The user doesn't want to proceed|This command requires approval|Claude requested permissions to)/.test(trimmed);
    const kind = isPermissionDenial ? "permission-denial" : hookLabel ? "hook-denial" : "tool-error";
    addIncident(kind, text, hookLabel ? { toolName: hookLabel } : toolFields);
    if (tool?.name !== "Bash" || !tool.command) return;
    const failures = failuresByCommand.get(tool.command) ?? { count: 0 };
    failures.count += 1;
    failuresByCommand.set(tool.command, failures);
    if (failures.count === 2) {
      failures.incident = addIncident("repeated-failure", tool.command, { toolName: "Bash", count: 2 });
    }
    if (failures.incident) failures.incident.count = failures.count;
  }

  const transcriptStream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input: transcriptStream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      digest.lineCount += 1;
      const entry = readObject(line);
      if (!entry) {
        digest.malformedLineCount += 1;
        continue;
      }
      if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") continue;
      if (typeof entry.sessionId === "string" && entry.sessionId) digest.sessionId = entry.sessionId;
      if (typeof entry.cwd === "string" && digest.cwd === null) digest.cwd = entry.cwd;
      if (typeof entry.gitBranch === "string" && digest.gitBranch === null) digest.gitBranch = entry.gitBranch;
      if (typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))) {
        digest.startedAt ??= entry.timestamp;
        digest.endedAt = entry.timestamp;
      }
      if (entry.type === "system") {
        if (entry.subtype === "compact_boundary") addIncident("compaction", asText(entry.subtype));
        continue;
      }
      const content = asObject(entry.message)?.content;
      if (entry.type === "user" && typeof content === "string") {
        recordPrompt(content, entry);
        continue;
      }
      if (!Array.isArray(content)) continue;
      const blocks = content.map(asObject).filter((block): block is JsonObject => block !== null);
      if (entry.type === "user") {
        const promptText = blocks.filter((block) => block.type === "text").map((block) => asText(block.text)).join("\n");
        recordPrompt(promptText, entry);
        for (const block of blocks) {
          if (block.type === "tool_result") recordToolResult(block, asObject(entry.toolUseResult));
        }
        continue;
      }
      for (const block of blocks) {
        if (block.type === "tool_use") recordToolUse(block);
      }
    }
  } catch (error) {
    throw new Error(`Cannot read transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    lines.close();
    transcriptStream.destroy();
  }
  if (options.includeGit !== false) appendGitIncidents(digest);
  return digest;
}
