import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { withLedgerLock } from "../../committing/lib/ledger.ts";

export type SessionEntry = {
  v: 1; kind: "session"; at: string; sessionId: string; transcriptPath: string;
  repo: string | null; incidentCount: number; counts: Record<string, number>; reviewed: boolean;
};
export type SightingEntry = {
  v: 1; kind: "sighting"; at: string; sessionId: string; lessonKey: string;
  summary: string; incidentKinds: string[]; lines: number[]; explicit: boolean;
};
export const CHANGE_KINDS = ["hook", "test", "skill-edit", "agents-line", "retirement"] as const;
export type ProposalEntry = {
  v: 1; kind: "proposal"; at: string; id: string; lessonKey: string; sessionIds: string[];
  target: string; changeKind: (typeof CHANGE_KINDS)[number];
  summary: string; origin: "focus"; status: "pending" | "applied" | "declined";
};
type RetroEntry = SessionEntry | SightingEntry | ProposalEntry;
type RetroLedger = { sessions: SessionEntry[]; sightings: SightingEntry[]; proposals: ProposalEntry[] };

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n\u2028\u2029]/.test(value);
}
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}
export function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function hasEntryFields(value: unknown, kind: string, fields: string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return value.v === 1 && value.kind === kind && isIsoTimestamp(value.at)
    && Object.keys(value).every((field) => ["v", "kind", "at", ...fields].includes(field));
}
export function isLessonKey(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
export function isChangeKind(value: unknown): value is ProposalEntry["changeKind"] {
  return CHANGE_KINDS.some((changeKind) => changeKind === value);
}
export function isSummary(value: unknown): boolean {
  return isText(value) && value.length <= 200;
}
export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!hasEntryFields(value, "session", ["sessionId", "transcriptPath", "repo", "incidentCount", "counts", "reviewed"])) return false;
  return isText(value.sessionId) && isText(value.transcriptPath)
    && (value.repo === null || isText(value.repo)) && isCount(value.incidentCount)
    && isObject(value.counts) && Object.values(value.counts).every(isCount) && typeof value.reviewed === "boolean";
}
export function isSightingEntry(value: unknown): value is SightingEntry {
  if (!hasEntryFields(value, "sighting", ["sessionId", "lessonKey", "summary", "incidentKinds", "lines", "explicit"])) return false;
  return isText(value.sessionId) && isLessonKey(value.lessonKey) && isSummary(value.summary)
    && isStringList(value.incidentKinds) && Array.isArray(value.lines) && value.lines.every(isCount)
    && typeof value.explicit === "boolean";
}
export function isProposalEntry(value: unknown): value is ProposalEntry {
  if (!hasEntryFields(value, "proposal", ["id", "lessonKey", "sessionIds", "target", "changeKind", "summary", "origin", "status"])) return false;
  return isText(value.id) && isLessonKey(value.lessonKey) && isStringList(value.sessionIds) && value.sessionIds.length > 0
    && isText(value.target) && isChangeKind(value.changeKind)
    && isSummary(value.summary) && value.origin === "focus"
    && typeof value.status === "string" && ["pending", "applied", "declined"].includes(value.status);
}
export function retroLedgerPath(): string {
  const configuredPath = process.env.RETRO_LEDGER;
  if (configuredPath && isAbsolute(configuredPath)) return configuredPath;
  return join(homedir(), ".claude", "retro-ledger.jsonl");
}
function parseEntry(line: string): RetroEntry | null {
  try {
    const entry: unknown = JSON.parse(line);
    if (isSessionEntry(entry) || isSightingEntry(entry) || isProposalEntry(entry)) return entry;
    return null;
  } catch {
    return null;
  }
}
function readLines(atPath: string): string[] {
  try {
    const text = readFileSync(atPath, "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function endsMidLine(descriptor: number): boolean {
  const { size } = fstatSync(descriptor);
  if (size === 0) return false;
  const lastByte = Buffer.alloc(1);
  readSync(descriptor, lastByte, 0, 1, size - 1);
  return lastByte[0] !== 0x0a;
}
function appendEntries(entries: RetroEntry[], atPath: string): boolean {
  let descriptor: number | undefined;
  try {
    if (entries.length === 0) return true;
    descriptor = openSync(atPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const prefix = endsMidLine(descriptor) ? "\n" : "";
    appendFileSync(descriptor, prefix + entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function rewriteLines(lines: string[], atPath: string): boolean {
  const temporaryPath = `${atPath}.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, atPath);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
function mutateLedger(atPath: string, mutate: () => boolean): boolean {
  try {
    return withLedgerLock(atPath, mutate) === true;
  } catch {
    return false;
  }
}
export function recordSession(entry: SessionEntry, atPath = retroLedgerPath()): boolean {
  if (!isSessionEntry(entry)) return false;
  return mutateLedger(atPath, () => appendEntries([entry], atPath));
}
export function replaceSessionSightings(sessionId: string, sightings: SightingEntry[], atPath = retroLedgerPath()): boolean {
  if (!isText(sessionId) || !sightings.every((entry) => isSightingEntry(entry) && entry.sessionId === sessionId)) return false;
  return mutateLedger(atPath, () => {
    const keptLines = readLines(atPath).filter((line) => {
      const entry = parseEntry(line);
      return entry?.kind !== "sighting" || entry.sessionId !== sessionId;
    });
    return rewriteLines([...keptLines, ...sightings.map((entry) => JSON.stringify(entry))], atPath);
  });
}
export function recordProposals(proposals: ProposalEntry[], atPath = retroLedgerPath()): boolean {
  if (!proposals.every(isProposalEntry)) return false;
  return mutateLedger(atPath, () => {
    const knownIds = new Set(readLines(atPath).map(parseEntry).filter(isProposalEntry).map((entry) => entry.id));
    const newProposals = proposals.filter((entry) => {
      if (knownIds.has(entry.id)) return false;
      knownIds.add(entry.id);
      return true;
    });
    return appendEntries(newProposals, atPath);
  });
}
export function setProposalStatus(id: string, status: ProposalEntry["status"], atPath = retroLedgerPath()): boolean {
  if (!["pending", "applied", "declined"].includes(status)) return false;
  return mutateLedger(atPath, () => {
    const proposal = readRetroLedger(atPath).proposals.find((entry) => entry.id === id);
    if (!proposal) return false;
    return appendEntries([{ ...proposal, status, at: new Date().toISOString() }], atPath);
  });
}
export function readRetroLedger(atPath = retroLedgerPath()): RetroLedger {
  const sessionsById = new Map<string, SessionEntry>();
  const proposalsById = new Map<string, ProposalEntry>();
  const sightings: SightingEntry[] = [];
  try {
    for (const line of readLines(atPath)) {
      const entry = parseEntry(line);
      if (!entry) continue;
      if (entry.kind === "sighting") sightings.push(entry);
      if (entry.kind === "session") {
        const previous = sessionsById.get(entry.sessionId);
        if (!previous || Date.parse(entry.at) >= Date.parse(previous.at)) sessionsById.set(entry.sessionId, entry);
      }
      if (entry.kind === "proposal") {
        const previous = proposalsById.get(entry.id);
        if (!previous || Date.parse(entry.at) >= Date.parse(previous.at)) proposalsById.set(entry.id, entry);
      }
    }
    return { sessions: [...sessionsById.values()], sightings, proposals: [...proposalsById.values()] };
  } catch {
    return { sessions: [], sightings: [], proposals: [] };
  }
}
export function lessonsReadyToPropose(sightings: SightingEntry[]): Map<string, SightingEntry[]> {
  const lessons = new Map<string, { sightings: SightingEntry[]; sessionIds: Set<string>; explicit: boolean }>();
  for (const sighting of sightings) {
    const lesson = lessons.get(sighting.lessonKey) ?? { sightings: [], sessionIds: new Set<string>(), explicit: false };
    lesson.sightings.push(sighting);
    lesson.sessionIds.add(sighting.sessionId);
    lesson.explicit ||= sighting.explicit;
    lessons.set(sighting.lessonKey, lesson);
  }
  return new Map([...lessons].filter(([, lesson]) => lesson.explicit || lesson.sessionIds.size >= 2)
    .map(([lessonKey, lesson]) => [lessonKey, lesson.sightings]));
}
export function pendingProposals(ledger: RetroLedger): ProposalEntry[] {
  return ledger.proposals.filter((entry) => entry.status === "pending").sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
}
export function unreviewedSessions(ledger: RetroLedger, minimumIncidents: number): SessionEntry[] {
  return ledger.sessions.filter((entry) => !entry.reviewed && entry.incidentCount >= minimumIncidents)
    .sort((first, second) => Date.parse(second.at) - Date.parse(first.at));
}
