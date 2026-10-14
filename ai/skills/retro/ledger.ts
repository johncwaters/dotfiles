import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  lessonsReadyToPropose, pendingProposals, readRetroLedger, recordProposals, recordSession,
  replaceSessionSightings, retroLedgerPath, setProposalStatus, unreviewedSessions,
} from "./lib/ledger.ts";
import { validateRetroRun } from "./lib/report.ts";
import type { ProposalEntry } from "./lib/ledger.ts";
import type { RetroRun } from "./lib/report.ts";

type Arguments = { command: string; positional: string[]; ledger: string; repo?: string; origin?: "focus" | "headless" };
function parseArguments(argumentsList: string[]): Arguments {
  const options: Arguments = { command: "", positional: [], ledger: retroLedgerPath() };
  const seenOptions = new Set<string>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index] ?? "";
    if (argument.startsWith("--")) {
      if (!["--ledger", "--repo", "--origin"].includes(argument) || seenOptions.has(argument)) throw new Error(`Unexpected option: ${argument}`);
      seenOptions.add(argument);
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      index += 1;
      if (argument === "--ledger" || argument === "--repo") {
        if (!isAbsolute(value)) throw new Error(`${argument}: must be an absolute path`);
        if (argument === "--ledger") options.ledger = value;
        if (argument === "--repo") options.repo = value;
        continue;
      }
      if (value !== "focus" && value !== "headless") throw new Error("--origin: must be focus or headless");
      options.origin = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unexpected option: ${argument}`);
    if (!options.command) {
      options.command = argument;
      continue;
    }
    options.positional.push(argument);
  }
  if (!["show", "record-run", "set-status"].includes(options.command)) throw new Error("Supply show, record-run, or set-status");
  if (options.repo && options.command !== "show") throw new Error("--repo: only valid with show");
  if (options.origin && options.command !== "record-run") throw new Error("--origin: only valid with record-run");
  if (options.command === "show" && options.positional.length !== 0) throw new Error("show: accepts no positional arguments");
  if (options.command === "record-run" && (options.positional.length !== 1 || !options.origin)) throw new Error("record-run: supply one run JSON file and --origin focus|headless");
  if (options.command === "set-status" && (options.positional.length !== 2 || !["applied", "declined"].includes(options.positional[1] ?? ""))) throw new Error("set-status: supply a proposal id and applied|declined");
  return options;
}
function fail(errors: string[]): void {
  process.stdout.write(`${JSON.stringify({ errors })}\n`);
  process.exitCode = 1;
}
function showLedger(options: Arguments): void {
  const ledger = readRetroLedger(options.ledger);
  const readyLessons = [...lessonsReadyToPropose(ledger.sightings)].map(([lessonKey, sightings]) => ({
    lessonKey, sessionIds: [...new Set(sightings.map((sighting) => sighting.sessionId))],
    explicit: sightings.some((sighting) => sighting.explicit), summaries: [...new Set(sightings.map((sighting) => sighting.summary))],
  }));
  process.stdout.write(`${JSON.stringify({
    pendingProposals: pendingProposals(ledger), readyLessons,
    knownLessonKeys: [...new Set([...ledger.sightings, ...ledger.proposals].map((entry) => entry.lessonKey))],
    unreviewedSessions: unreviewedSessions(ledger, 1).filter((session) => !options.repo || session.repo === options.repo),
  })}\n`);
}
function conflictingProposalErrors(run: RetroRun, ledgerPath: string): string[] {
  const knownProposalsById = new Map(readRetroLedger(ledgerPath).proposals.map((proposal) => [proposal.id, proposal]));
  return run.report.proposals.flatMap((proposal, index) => {
    const knownProposal = knownProposalsById.get(proposal.id);
    if (!knownProposal || (knownProposal.lessonKey === proposal.lessonKey && knownProposal.target === proposal.target)) return [];
    return [`report.proposals[${index}].id: ${JSON.stringify(proposal.id)} already names lesson ${knownProposal.lessonKey} at ${knownProposal.target} in the ledger`];
  });
}
function recordRun(run: RetroRun, options: Arguments): void {
  const conflictErrors = conflictingProposalErrors(run, options.ledger);
  if (conflictErrors.length > 0) {
    fail(conflictErrors);
    return;
  }
  const at = new Date().toISOString();
  let sightingCount = 0;
  const reviewedSessionIds = new Set([...run.sessions.map((session) => session.sessionId), ...Object.keys(run.sightings)]);
  for (const sessionId of reviewedSessionIds) {
    const sightings = Object.hasOwn(run.sightings, sessionId) ? run.sightings[sessionId] ?? [] : [];
    if (!replaceSessionSightings(sessionId, sightings.map((sighting) => ({ ...sighting, v: 1, kind: "sighting", at, sessionId })), options.ledger)) {
      fail([`sightings[${JSON.stringify(sessionId)}]: could not replace ledger sightings`]);
      return;
    }
    sightingCount += sightings.length;
  }
  const knownIds = new Set(readRetroLedger(options.ledger).proposals.map((proposal) => proposal.id));
  const proposals: ProposalEntry[] = run.report.proposals.filter((proposal) => !knownIds.has(proposal.id)).map((proposal) => ({
    v: 1, kind: "proposal", at, id: proposal.id, lessonKey: proposal.lessonKey,
    sessionIds: [...new Set(proposal.incidents.map((incident) => incident.sessionId))],
    target: proposal.target, changeKind: proposal.changeKind, summary: proposal.summary,
    origin: options.origin as "focus" | "headless", status: "pending",
  }));
  if (!recordProposals(proposals, options.ledger)) {
    fail(["proposals: could not append ledger proposals"]);
    return;
  }
  for (const session of run.sessions) {
    if (!recordSession({ ...session, v: 1, kind: "session", at, reviewed: true }, options.ledger)) {
      fail([`sessions[${JSON.stringify(session.sessionId)}]: could not append reviewed session`]);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify({ recorded: { sightings: sightingCount, proposals: proposals.length, sessions: run.sessions.length } })}\n`);
}
try {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "show") showLedger(options);
  if (options.command === "record-run") {
    const run: unknown = JSON.parse(readFileSync(options.positional[0] as string, "utf8"));
    const errors = validateRetroRun(run);
    if (errors.length > 0) fail(errors);
    if (errors.length === 0) recordRun(run as RetroRun, options);
  }
  if (options.command === "set-status") {
    const id = options.positional[0] as string;
    const status = options.positional[1] as "applied" | "declined";
    if (!setProposalStatus(id, status, options.ledger)) fail([`proposal ${id}: not found or ledger could not be updated`]);
    if (!process.exitCode) process.stdout.write(`${JSON.stringify({ id, status })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ errors: [error instanceof Error ? error.message : String(error)] })}\n`);
  process.exitCode = 2;
}
