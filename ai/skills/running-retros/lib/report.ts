import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isChangeKind, isIsoTimestamp, isLessonKey, isObject, isSessionEntry, isSightingEntry, isStringList, isSummary, isText,
} from "./ledger.ts";
import type { ProposalEntry, SessionEntry, SightingEntry } from "./ledger.ts";

export const MAX_PROPOSALS = 5;
export type ReportProposal = {
  id: string; lessonKey: string; target: string; changeKind: ProposalEntry["changeKind"];
  summary: string; incidents: { sessionId: string; line: number; kind: string }[];
  pairedRetirement?: string;
};
export type RetroReport = {
  v: 1; generatedAt: string; sessionIds: string[]; outcome: "proposals" | "nothing-durable";
  proposals: ReportProposal[]; reported: { summary: string; owner: string }[];
};
export type SightingInput = Omit<SightingEntry, "v" | "kind" | "at" | "sessionId">;
export type RetroRun = {
  report: RetroReport;
  sightings: Record<string, SightingInput[]>;
  sessions: Omit<SessionEntry, "v" | "kind" | "at" | "reviewed">[];
};

function isTarget(value: unknown): boolean {
  if (!isText(value) || value.includes("\\")) return false;
  if (value.split("/").some((part) => part === "..")) return false;
  if (value.startsWith("~/.dotfiles/")) return value.slice("~/.dotfiles/".length).split("/").some((part) => part && part !== ".");
  if (value.startsWith("~")) return false;
  if (!isAbsolute(value)) return value.split("/").some((part) => part && part !== ".");
  const withinDotfiles = relative(resolve(homedir(), ".dotfiles"), resolve(value));
  return withinDotfiles !== "" && !withinDotfiles.startsWith(`..${sep}`) && withinDotfiles !== ".." && !isAbsolute(withinDotfiles);
}
function checkFields(value: Record<string, unknown>, allowed: string[], path: string, errors: string[]): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) errors.push(`${path ? `${path}.` : ""}${field}: remove unknown field`);
  }
}
function validateProposal(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be a proposal object`);
    return;
  }
  checkFields(value, ["id", "lessonKey", "target", "changeKind", "summary", "incidents", "pairedRetirement"], path, errors);
  if (!isText(value.id)) errors.push(`${path}.id: must be a nonempty one-line string`);
  if (!isLessonKey(value.lessonKey)) errors.push(`${path}.lessonKey: must be a kebab-case slug`);
  if (!isTarget(value.target)) errors.push(`${path}.target: must be a repo-relative path or a path under ~/.dotfiles without parent traversal`);
  if (!isChangeKind(value.changeKind)) errors.push(`${path}.changeKind: must be hook, test, skill-edit, agents-line, or retirement`);
  if (!isSummary(value.summary)) errors.push(`${path}.summary: must be one line of at most 200 characters`);
  if (Object.hasOwn(value, "pairedRetirement") && !isSummary(value.pairedRetirement)) errors.push(`${path}.pairedRetirement: must name the retired rule in one line of at most 200 characters`);
  if (typeof value.pairedRetirement === "string" && /^none\b/i.test(value.pairedRetirement) && !/^none: \S/.test(value.pairedRetirement)) errors.push(`${path}.pairedRetirement: write 'none: <reason>' with the reason`);
  if (value.changeKind === "hook" && !Object.hasOwn(value, "pairedRetirement")) errors.push(`${path}.pairedRetirement: a hook proposal names the prose its denial message restates, which its ticket deletes, or 'none: <why no prose restates it>'`);
  if (!Array.isArray(value.incidents) || value.incidents.length === 0) {
    errors.push(`${path}.incidents: must contain at least one source incident`);
    return;
  }
  value.incidents.forEach((incident: unknown, index: number) => {
    const incidentPath = `${path}.incidents[${index}]`;
    if (!isObject(incident)) {
      errors.push(`${incidentPath}: must be a source incident object`);
      return;
    }
    checkFields(incident, ["sessionId", "line", "kind"], incidentPath, errors);
    if (!isText(incident.sessionId)) errors.push(`${incidentPath}.sessionId: must be a nonempty one-line string`);
    if (!Number.isSafeInteger(incident.line) || (incident.line as number) < 0) errors.push(`${incidentPath}.line: must be a nonnegative integer`);
    if (!isText(incident.kind)) errors.push(`${incidentPath}.kind: must be a nonempty one-line string`);
  });
}
export function validateRetroReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ["report: must be an object"];
  checkFields(value, ["v", "generatedAt", "sessionIds", "outcome", "proposals", "reported"], "", errors);
  if (value.v !== 1) errors.push("v: must be 1");
  if (!isIsoTimestamp(value.generatedAt)) errors.push("generatedAt: must be an ISO timestamp");
  if (!isStringList(value.sessionIds) || value.sessionIds.length === 0) errors.push("sessionIds: must contain at least one nonempty session id");
  if (value.outcome !== "proposals" && value.outcome !== "nothing-durable") errors.push("outcome: must be proposals or nothing-durable");
  if (!Array.isArray(value.proposals)) errors.push("proposals: must be an array");
  if (Array.isArray(value.proposals)) {
    if (value.proposals.length > MAX_PROPOSALS) errors.push(`proposals: must contain at most ${MAX_PROPOSALS} proposals`);
    if (value.outcome === "nothing-durable" && value.proposals.length !== 0) errors.push("proposals: must be empty when outcome is nothing-durable");
    if (value.outcome === "proposals" && value.proposals.length === 0) errors.push("proposals: must contain at least one proposal when outcome is proposals");
    const proposalIds = new Set<string>();
    value.proposals.forEach((proposal: unknown, index: number) => {
      validateProposal(proposal, `proposals[${index}]`, errors);
      if (!isObject(proposal) || typeof proposal.id !== "string") return;
      if (proposalIds.has(proposal.id)) errors.push(`proposals[${index}].id: must be unique within the report`);
      proposalIds.add(proposal.id);
    });
  }
  if (!Array.isArray(value.reported)) errors.push("reported: must be an array");
  if (Array.isArray(value.reported)) value.reported.forEach((reported: unknown, index: number) => {
    const path = `reported[${index}]`;
    if (!isObject(reported)) {
      errors.push(`${path}: must be an object with summary and owner`);
      return;
    }
    checkFields(reported, ["summary", "owner"], path, errors);
    if (!isSummary(reported.summary)) errors.push(`${path}.summary: must be one line of at most 200 characters`);
    if (!isText(reported.owner)) errors.push(`${path}.owner: must be a nonempty one-line string`);
  });
  return errors;
}
export function isRetroReport(value: unknown): value is RetroReport {
  return validateRetroReport(value).length === 0;
}
export function validateRetroRun(value: unknown): string[] {
  if (!isObject(value)) return ["run: must be an object"];
  const errors = validateRetroReport(value.report).map((error) => `report.${error}`);
  checkFields(value, ["report", "sightings", "sessions"], "", errors);
  const reportSessionIds = new Set(isObject(value.report) && isStringList(value.report.sessionIds) ? value.report.sessionIds : []);
  if (isObject(value.report) && Array.isArray(value.report.proposals)) value.report.proposals.forEach((proposal: unknown, proposalIndex: number) => {
    if (!isObject(proposal) || !Array.isArray(proposal.incidents)) return;
    proposal.incidents.forEach((incident: unknown, incidentIndex: number) => {
      if (!isObject(incident) || reportSessionIds.has(incident.sessionId as string)) return;
      errors.push(`report.proposals[${proposalIndex}].incidents[${incidentIndex}].sessionId: must be listed in report.sessionIds`);
    });
  });
  const at = new Date().toISOString();
  if (!isObject(value.sightings)) errors.push("sightings: must map session ids to sighting arrays");
  if (isObject(value.sightings)) for (const [sessionId, sightings] of Object.entries(value.sightings)) {
    const path = `sightings[${JSON.stringify(sessionId)}]`;
    if (!isText(sessionId)) errors.push(`${path}: must use a nonempty one-line session id`);
    if (!reportSessionIds.has(sessionId)) errors.push(`${path}: must be a session id listed in report.sessionIds`);
    if (!Array.isArray(sightings)) {
      errors.push(`${path}: must be an array of sightings`);
      continue;
    }
    sightings.forEach((sighting: unknown, index: number) => {
      if (!isObject(sighting)) {
        errors.push(`${path}[${index}]: must be a sighting object`);
        return;
      }
      checkFields(sighting, ["lessonKey", "summary", "incidentKinds", "lines", "explicit"], `${path}[${index}]`, errors);
      if (!isSightingEntry({ ...sighting, v: 1, kind: "sighting", at, sessionId })) errors.push(`${path}[${index}]: supply a kebab-case lessonKey, one-line summary of at most 200 characters, incidentKinds string array, nonnegative integer lines, and explicit boolean`);
    });
  }
  if (!Array.isArray(value.sessions)) errors.push("sessions: must be an array");
  if (Array.isArray(value.sessions)) value.sessions.forEach((session: unknown, index: number) => {
    if (!isObject(session)) {
      errors.push(`sessions[${index}]: must be a session object`);
      return;
    }
    checkFields(session, ["sessionId", "transcriptPath", "repo", "incidentCount", "counts"], `sessions[${index}]`, errors);
    if (!reportSessionIds.has(session.sessionId as string)) errors.push(`sessions[${index}].sessionId: must be listed in report.sessionIds`);
    if (!isSessionEntry({ ...session, v: 1, kind: "session", at, reviewed: true })) errors.push(`sessions[${index}]: supply sessionId, transcriptPath, repo (string or null), nonnegative incidentCount, and nonnegative integer counts`);
  });
  return errors;
}
