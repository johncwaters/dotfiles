import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultProjectsDir, listTranscriptsSince } from "../running-retros/lib/digest.ts";

type Usage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
type TranscriptLine = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  compactMetadata?: { trigger?: string; preTokens?: number; precomputed?: boolean; durationMs?: number };
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
};
type Call = { usage: Usage; model: string };
type PricePerMillion = { input: number; cacheRead: number; write5m: number; write1h: number; output: number };
type Compaction = {
  preTokens: number;
  firstPostContext: number;
  isPrecomputed: boolean;
  isManual: boolean;
  durationMs: number;
  idleSeconds: number;
  callsUntilNext: number;
  rebuildDollars: number;
  summaryReadDollars: number;
  summaryUncachedDollars: number;
  savingPerCallDollars: number;
};
type Delegation = { agentCalls: number; workflowCalls: number; childSessionSpawns: number; subagentTranscripts: number };
export type SessionSummary = {
  peakContext: number;
  contextTokens: number;
  withoutCapContextTokens: number;
  compactions: Compaction[];
  delegation: Delegation;
  unpricedModels: string[];
  calledAt: [string, number, number][];
};

const PRICES_AS_OF = "2026-11-03";
const PRICE_BY_MODEL: Record<string, PricePerMillion> = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, write5m: 5, write1h: 8, output: 20 },
  "claude-fable-5-2": { input: 8, cacheRead: 0.2, write5m: 10, write1h: 16, output: 40 },
};
const FALLBACK_MODEL = "claude-opus-5-5";
const PRE_CAP_AUTO_COMPACT_TOKENS = 967_000;
const CHARACTERS_PER_TOKEN = 4;

function priceFor(model: string): PricePerMillion {
  return PRICE_BY_MODEL[model] ?? PRICE_BY_MODEL[FALLBACK_MODEL]!;
}

function contextOf(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

function cacheWriteDollars(usage: Usage, price: PricePerMillion): number {
  const breakdown = usage.cache_creation;
  if (!breakdown) return ((usage.cache_creation_input_tokens ?? 0) * price.write5m) / 1e6;
  return ((breakdown.ephemeral_5m_input_tokens ?? 0) * price.write5m + (breakdown.ephemeral_1h_input_tokens ?? 0) * price.write1h) / 1e6;
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => total + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function readLines(transcriptPath: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const rawLine of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!rawLine) continue;
    try {
      lines.push(JSON.parse(rawLine));
    } catch {
      continue;
    }
  }
  return lines;
}

function countDelegation(lines: TranscriptLine[], transcriptPath: string): Delegation {
  const delegation: Delegation = { agentCalls: 0, workflowCalls: 0, childSessionSpawns: 0, subagentTranscripts: 0 };
  for (const line of lines) {
    const content = line.type === "assistant" ? line.message?.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "Agent" || block.name === "Task") delegation.agentCalls += 1;
      if (block.name === "Workflow") delegation.workflowCalls += 1;
      if (block.name === "mcp__glimmervoid__session" && block.input?.action === "spawn") delegation.childSessionSpawns += 1;
    }
  }
  const subagentDirectory = path.join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
  if (fs.existsSync(subagentDirectory)) {
    delegation.subagentTranscripts = fs.readdirSync(subagentDirectory).filter((name) => name.endsWith(".jsonl")).length;
  }
  return delegation;
}

export function summarizeSession(transcriptPath: string, since: string): SessionSummary | null {
  const lines = readLines(transcriptPath);
  const firstTimestamp = lines.find((line) => line.timestamp)?.timestamp;
  if (!firstTimestamp || firstTimestamp < since) return null;
  const calls: Call[] = [];
  const seenMessageIds = new Set<string>();
  const boundaries: { callIndex: number; timestamp: string; preTokens: number; isPrecomputed: boolean; isManual: boolean; durationMs: number; idleSeconds: number }[] = [];
  const summaryCharacters: number[] = [];
  const calledAt: [string, number, number][] = [];
  let lastEventTimestamp = firstTimestamp;
  let droppedSinceReset = 0;
  for (const line of lines) {
    if (line.subtype === "compact_boundary") {
      const timestamp = line.timestamp ?? lastEventTimestamp;
      const metadata = line.compactMetadata ?? {};
      boundaries.push({
        callIndex: calls.length,
        timestamp,
        preTokens: metadata.preTokens ?? 0,
        isPrecomputed: metadata.precomputed === true,
        isManual: metadata.trigger === "manual",
        durationMs: metadata.durationMs ?? 0,
        idleSeconds: (Date.parse(timestamp) - Date.parse(lastEventTimestamp)) / 1000,
      });
      continue;
    }
    if (line.isCompactSummary) summaryCharacters.push(textLength(line.message?.content));
    if (line.timestamp && (line.type === "user" || line.type === "assistant")) lastEventTimestamp = line.timestamp;
    const usage = line.type === "assistant" ? line.message?.usage : undefined;
    const messageId = line.message?.id;
    if (!usage || !messageId || seenMessageIds.has(messageId)) continue;
    seenMessageIds.add(messageId);
    const isFirstCallAfterBoundary = boundaries.at(-1)?.callIndex === calls.length;
    const context = contextOf(usage);
    if (isFirstCallAfterBoundary) droppedSinceReset += Math.max(0, boundaries.at(-1)!.preTokens - context);
    if (context + droppedSinceReset >= PRE_CAP_AUTO_COMPACT_TOKENS) droppedSinceReset = 0;
    calls.push({ usage, model: line.message?.model ?? FALLBACK_MODEL });
    calledAt.push([line.timestamp ?? lastEventTimestamp, context, context + droppedSinceReset]);
  }
  if (calls.length === 0) return null;
  const summaryTokens = median(summaryCharacters) / CHARACTERS_PER_TOKEN;
  const compactions: Compaction[] = [];
  boundaries.forEach((boundary, position) => {
    const firstCall = calls[boundary.callIndex];
    if (!firstCall || boundary.preTokens === 0) return;
    const firstPostContext = contextOf(firstCall.usage);
    const droppedTokens = boundary.preTokens - firstPostContext;
    if (droppedTokens <= 0) return;
    const price = priceFor(firstCall.model);
    const nextCallIndex = boundaries[position + 1]?.callIndex ?? calls.length;
    const summaryOutputDollars = (summaryTokens * price.output) / 1e6;
    compactions.push({
      preTokens: boundary.preTokens,
      firstPostContext,
      isPrecomputed: boundary.isPrecomputed,
      isManual: boundary.isManual,
      durationMs: boundary.durationMs,
      idleSeconds: boundary.idleSeconds,
      callsUntilNext: nextCallIndex - boundary.callIndex,
      rebuildDollars: cacheWriteDollars(firstCall.usage, price),
      summaryReadDollars: (boundary.preTokens * price.cacheRead) / 1e6 + summaryOutputDollars,
      summaryUncachedDollars: (boundary.preTokens * price.input) / 1e6 + summaryOutputDollars,
      savingPerCallDollars: (droppedTokens * price.cacheRead) / 1e6,
    });
  });
  return {
    peakContext: Math.max(...calledAt.map(([, context]) => context)),
    contextTokens: calledAt.reduce((total, [, context]) => total + context, 0),
    withoutCapContextTokens: calledAt.reduce((total, [, , withoutCap]) => total + withoutCap, 0),
    compactions,
    delegation: boundaries.length > 0 ? countDelegation(lines, transcriptPath) : { agentCalls: 0, workflowCalls: 0, childSessionSpawns: 0, subagentTranscripts: 0 },
    unpricedModels: [...new Set(calls.map((call) => call.model).filter((model) => !PRICE_BY_MODEL[model] && model !== "<synthetic>"))],
    calledAt,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function compactionBucket(count: number): string {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count < 5) return "2-4";
  if (count < 10) return "5-9";
  return "10+";
}

function cumulativeSeries(sessions: SessionSummary[], maxPoints: number): [string, number, number][] {
  const calls = sessions.flatMap((session) => session.calledAt).sort((first, second) => first[0].localeCompare(second[0]));
  const series: [string, number, number][] = [];
  let actualTotal = 0;
  let withoutCapTotal = 0;
  const stride = Math.max(1, Math.floor(calls.length / maxPoints));
  calls.forEach(([timestamp, context, withoutCap], index) => {
    actualTotal += context;
    withoutCapTotal += withoutCap;
    if (index % stride === 0 || index === calls.length - 1) series.push([timestamp, actualTotal, withoutCapTotal]);
  });
  return series;
}

export function buildReport(sessions: SessionSummary[], since: string) {
  const compactingSessions = sessions.filter((session) => session.compactions.length > 0);
  const compactions = sessions.flatMap((session) => session.compactions);
  const totalContextTokens = sum(sessions.map((session) => session.contextTokens));
  const heavySessions = compactingSessions.filter((session) => session.compactions.length >= 10);
  const bucketCounts: Record<string, number> = { "0": 0, "1": 0, "2-4": 0, "5-9": 0, "10+": 0 };
  for (const session of sessions) bucketCounts[compactionBucket(session.compactions.length)]! += 1;
  const paybackFor = (summaryDollars: (compaction: Compaction) => number) => {
    const costs = compactions.map((compaction) => compaction.rebuildDollars + summaryDollars(compaction));
    const savings = compactions.map((compaction) => compaction.savingPerCallDollars * compaction.callsUntilNext);
    return {
      medianCostDollars: median(costs),
      medianSavedDollars: median(savings),
      medianBreakEvenCalls: median(compactions.map((compaction, index) => costs[index]! / compaction.savingPerCallDollars)),
      paidBack: compactions.filter((_, index) => savings[index]! > costs[index]!).length,
      totalCostDollars: sum(costs),
      totalSavedDollars: sum(savings),
    };
  };
  const delegationTotals = (key: keyof Delegation) => sum(compactingSessions.map((session) => session.delegation[key]));
  const precomputed = compactions.filter((compaction) => compaction.isPrecomputed);
  const manual = compactions.filter((compaction) => compaction.isManual);
  const idle = compactions.filter((compaction) => !compaction.isPrecomputed && !compaction.isManual);
  return {
    since,
    pricesAsOf: PRICES_AS_OF,
    unpricedModels: [...new Set(sessions.flatMap((session) => session.unpricedModels))],
    sessions: {
      total: sessions.length,
      compacting: compactingSessions.length,
      compactingContextShare: sum(compactingSessions.map((session) => session.contextTokens)) / totalContextTokens,
      peakUnder50kShare: sessions.filter((session) => session.peakContext < 50_000).length / sessions.length,
      peakUnder250kShare: sessions.filter((session) => session.peakContext < 250_000).length / sessions.length,
      compactionsPerSession: bucketCounts,
      tenPlus: { sessions: heavySessions.length, compactions: sum(heavySessions.map((session) => session.compactions.length)), contextShare: sum(heavySessions.map((session) => session.contextTokens)) / totalContextTokens },
      maxCompactions: Math.max(0, ...sessions.map((session) => session.compactions.length)),
    },
    compactions: {
      total: compactions.length,
      precomputed: precomputed.length,
      idle: idle.length,
      manual: manual.length,
      medianPreTokens: median(compactions.map((compaction) => compaction.preTokens)),
      medianFirstPostContext: median(compactions.map((compaction) => compaction.firstPostContext)),
      medianDroppedTokens: median(compactions.map((compaction) => compaction.preTokens - compaction.firstPostContext)),
      medianPrecomputedDurationMs: median(precomputed.map((compaction) => compaction.durationMs)),
      medianIdleMinutesBeforeIdleCompaction: median(idle.map((compaction) => compaction.idleSeconds / 60)),
      medianCallsUntilNext: median(compactions.map((compaction) => compaction.callsUntilNext)),
    },
    reread: {
      actualTokens: totalContextTokens,
      withoutCapTokens: sum(sessions.map((session) => session.withoutCapContextTokens)),
      series: cumulativeSeries(sessions, 600),
    },
    payback: {
      summaryReadFromCache: paybackFor((compaction) => compaction.summaryReadDollars),
      summaryUncached: paybackFor((compaction) => compaction.summaryUncachedDollars),
    },
    delegation: {
      compactingSessionsThatDelegated: compactingSessions.filter((session) => sum(Object.values(session.delegation)) > 0).length,
      agentCalls: delegationTotals("agentCalls"),
      workflowCalls: delegationTotals("workflowCalls"),
      childSessionSpawns: delegationTotals("childSessionSpawns"),
      subagentTranscripts: delegationTotals("subagentTranscripts"),
    },
  };
}

export type CompactionReport = ReturnType<typeof buildReport>;

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatReport(report: CompactionReport): string {
  const { sessions, compactions, reread, payback, delegation } = report;
  const paybackLine = (label: string, figures: CompactionReport["payback"]["summaryReadFromCache"]) =>
    `${label}: cost ${dollars(figures.medianCostDollars)}, saved before next ${dollars(figures.medianSavedDollars)}, break-even ${figures.medianBreakEvenCalls.toFixed(0)} calls, paid back ${figures.paidBack}/${compactions.total}, total cost ${dollars(figures.totalCostDollars)} saved ${dollars(figures.totalSavedDollars)}`;
  return [
    `since ${report.since}, prices as of ${report.pricesAsOf}${report.unpricedModels.length ? `, priced as ${FALLBACK_MODEL}: ${report.unpricedModels.join(", ")}` : ""}`,
    `sessions ${sessions.total}, compacting ${sessions.compacting} (${percent(sessions.compacting / sessions.total)}) holding ${percent(sessions.compactingContextShare)} of context tokens`,
    `peak context <50k ${percent(sessions.peakUnder50kShare)}, <250k ${percent(sessions.peakUnder250kShare)}`,
    `compactions per session ${JSON.stringify(sessions.compactionsPerSession)}, max ${sessions.maxCompactions}; 10+ sessions ${sessions.tenPlus.sessions} with ${sessions.tenPlus.compactions} compactions, ${percent(sessions.tenPlus.contextShare)} of tokens`,
    `compactions ${compactions.total}: precomputed ${compactions.precomputed} (median ${compactions.medianPrecomputedDurationMs}ms), idle ${compactions.idle} (median ${compactions.medianIdleMinutesBeforeIdleCompaction.toFixed(0)} min after the last turn), manual ${compactions.manual}`,
    `median pre ${compactions.medianPreTokens}, first post-compaction context ${compactions.medianFirstPostContext}, dropped ${compactions.medianDroppedTokens}, calls until next ${compactions.medianCallsUntilNext}`,
    `context re-read ${(reread.actualTokens / 1e9).toFixed(1)}B, without the cap ${(reread.withoutCapTokens / 1e9).toFixed(1)}B, never re-read ${((reread.withoutCapTokens - reread.actualTokens) / 1e9).toFixed(1)}B`,
    paybackLine("payback, summary read from cache", payback.summaryReadFromCache),
    paybackLine("payback, summary uncached", payback.summaryUncached),
    `delegation in compacting sessions: ${delegation.compactingSessionsThatDelegated}/${sessions.compacting} delegated; Workflow ${delegation.workflowCalls}, Agent/Task ${delegation.agentCalls}, child sessions ${delegation.childSessionSpawns}, subagent transcripts ${delegation.subagentTranscripts}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { since: { type: "string" }, json: { type: "string" }, graphics: { type: "string" } },
  });
  const since = values.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(since))) throw new Error(`--since must be a date, got ${since}`);
  const transcriptPaths = listTranscriptsSince(defaultProjectsDir(), since);
  const sessions = transcriptPaths.flatMap((transcriptPath) => summarizeSession(transcriptPath, since) ?? []);
  if (sessions.length === 0) throw new Error(`no sessions with model calls since ${since}`);
  const report = buildReport(sessions, since);
  console.log(formatReport(report));
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(report));
  if (!values.graphics) return;
  if (report.compactions.total === 0) throw new Error(`no compactions since ${report.since}, so there is nothing to chart`);
  const { renderGraphics } = await import("./graphics.ts");
  for (const pngPath of await renderGraphics(report, values.graphics)) console.log(pngPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
