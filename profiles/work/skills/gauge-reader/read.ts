import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ReaderOptions = { batchIds: string[]; runIds: string[]; factsPath?: string; cacheRoot: string };
type GaugeEvent = Record<string, unknown> & { type: string; seq?: number | string; ts?: string };
type CriterionResult = { name: string; passed: boolean | null };
type GaugeRun = {
  id: string; status: string; agent: string; model: string; batchId?: string; evalSetId?: string;
  durationMs?: number; creditsCharged?: number | null; criterionResults?: CriterionResult[];
};
type FactDefinition = { name: string; pattern: string; expected: string };
type FactsFile = { docsUrlPattern: string; sdkPattern: string; facts: FactDefinition[] };
type Provenance = {
  origin: "docs" | "sdk" | "other" | "unlogged-web" | "none"; seq: number | null; isCertain: boolean; toolInput: string;
};
type FactReading = {
  name: string; expected: string; writtenValues: string[]; passed: boolean | null;
  provenance: Provenance | null;
};
type DocsRequest = { url: string; bytes: number; format: string };
type RunRow = {
  runId: string; batchId: string; status: string; isComplete: boolean; agent: string; model: string;
  creditsCharged: number | null; sandboxDocsRequests: DocsRequest[]; webEvents: { kind: string; target: string }[];
  facts: FactReading[];
  criteriaPassed: number; criteriaTotal: number; failingCriteria: string[]; unassessedCriteria: string[];
  comparableCriteriaPassed: number; comparableCriteriaTotal: number; hasReachedDocs: boolean;
  npmWindowSeconds: number | null; totalSeconds: number | null;
};

const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"]);
const docsReadCriterionName = "Read PostHog docs before coding";
const skillDirectory = import.meta.dirname;
const gaugeIdPattern = /^[a-z0-9]+$/;

function requireGaugeId(id: string, kind: string): string {
  if (!gaugeIdPattern.test(id)) throw new Error(`Invalid ${kind} id ${JSON.stringify(id)}: expected lowercase letters and digits only`);
  return id;
}

function parseArguments(argumentsList: string[]): ReaderOptions {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const options: ReaderOptions = { batchIds: [], runIds: [], cacheRoot: join(cacheHome, "gauge-reader") };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index] ?? "";
    if (!argument.startsWith("--")) {
      options.runIds.push(argument);
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--batch") options.batchIds.push(requireGaugeId(value, "batch"));
    if (argument === "--facts") options.factsPath = value;
    if (argument === "--cache-dir") options.cacheRoot = value;
    if (!["--batch", "--facts", "--cache-dir"].includes(argument)) throw new Error(`Unexpected argument: ${argument}`);
  }
  if (options.batchIds.length + options.runIds.length === 0) throw new Error("Provide --batch <id> or run ids");
  return options;
}

function gaugeBinary(): string {
  if (process.env.GAUGE_BIN) return process.env.GAUGE_BIN;
  const userInstall = join(homedir(), ".npm-global/bin/gauge");
  return existsSync(userInstall) ? userInstall : "gauge";
}

function runGauge(gaugeArguments: string[]): string {
  const gaugeProcess = spawnSync(gaugeBinary(), gaugeArguments, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (gaugeProcess.status !== 0) {
    throw new Error(`gauge ${gaugeArguments.join(" ")} failed: ${gaugeProcess.stderr || gaugeProcess.stdout || gaugeProcess.error || `exit ${gaugeProcess.status}`}`);
  }
  return gaugeProcess.stdout;
}

function listBatchRunIds(batchId: string, cacheRoot: string): string[] {
  const cachedRowsPath = join(cacheRoot, batchId, "runs.json");
  if (existsSync(cachedRowsPath)) {
    const cachedRows = JSON.parse(readFileSync(cachedRowsPath, "utf8")) as RunRow[];
    if (cachedRows.length > 0 && cachedRows.every((row) => row.isComplete)) return cachedRows.map((row) => row.runId);
  }
  const runIds: string[] = [];
  let cursor = "";
  do {
    const page = JSON.parse(runGauge(["run", "list", "--batch", batchId, "--limit", "200", "-o", "json",
      ...(cursor ? ["--cursor", cursor] : [])])) as { items: GaugeRun[]; nextCursor?: string | null };
    runIds.push(...page.items.map((run) => run.id));
    cursor = page.nextCursor ?? "";
  } while (cursor);
  return runIds;
}

function loadRun(runId: string, cacheRoot: string): { run: GaugeRun; events: GaugeEvent[]; diff: string } {
  const runDirectory = join(cacheRoot, "runs", requireGaugeId(runId, "run"));
  const runPath = join(runDirectory, "run.json");
  const logPath = join(runDirectory, "log.jsonl");
  const diffPath = join(runDirectory, "diff.patch");
  if (existsSync(runPath) && existsSync(logPath) && existsSync(diffPath)) {
    return { run: JSON.parse(readFileSync(runPath, "utf8")), events: parseEvents(readFileSync(logPath, "utf8")), diff: readFileSync(diffPath, "utf8") };
  }
  const run = JSON.parse(runGauge(["run", "get", runId, "-o", "json"])) as GaugeRun;
  const log = runGauge(["run", "get", runId, "--logs", "-o", "json"]);
  const diff = runGauge(["run", "diff", runId]);
  if (terminalStatuses.has(run.status)) {
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(runPath, JSON.stringify(run));
    writeFileSync(logPath, log);
    writeFileSync(diffPath, diff);
  }
  return { run, events: parseEvents(log), diff };
}

function parseEvents(log: string): GaugeEvent[] {
  return log.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as GaugeEvent);
}

function loadFacts(options: ReaderOptions, evalSetId: string | undefined): FactsFile | null {
  const factsPath = options.factsPath ?? (evalSetId ? join(skillDirectory, "facts", `${evalSetId}.json`) : "");
  if (!factsPath || !existsSync(factsPath)) return null;
  return JSON.parse(readFileSync(factsPath, "utf8")) as FactsFile;
}

function sequenceOf(event: GaugeEvent): number {
  return Number(event.seq ?? 0);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function docsFormat(url: string, bytes: number): string {
  if (bytes < 100) return "tiny";
  const path = url.split(/[?#]/)[0] ?? "";
  if (path.endsWith(".md") || path.endsWith(".txt")) return "md";
  if (path.endsWith(".mdx")) return "mdx";
  return "html";
}

function writtenValues(diff: string, pattern: string): Map<string, Set<string>> {
  const filesByValue = new Map<string, Set<string>>();
  const matcher = new RegExp(pattern, "g");
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    for (const match of line.matchAll(matcher)) {
      if (!match[1]) continue;
      filesByValue.set(match[1], (filesByValue.get(match[1]) ?? new Set()).add(currentFile));
    }
  }
  return filesByValue;
}

type OriginMatchers = { docs: RegExp; sdk: RegExp };

function sightingOrigin(toolInput: string, originMatchers: OriginMatchers): Provenance["origin"] {
  if (originMatchers.docs.test(toolInput)) return "docs";
  if (originMatchers.sdk.test(toolInput)) return "sdk";
  return "other";
}

const inPlaceEditPattern = /\bsed -i|\bperl -p?i|\btee\b|apply_patch/;

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isShellWriteTo(toolInput: string, filesWithValue: Set<string>): boolean {
  return [...filesWithValue].some((file) => {
    if (!toolInput.includes(file)) return false;
    return inPlaceEditPattern.test(toolInput) || new RegExp(`>>?\\s*(\\./)?${escapeForRegex(file)}`).test(toolInput);
  });
}

const editContentKeys = ['"content"', '"new_string"', '"edits"', '"patch"'];

function writeKind(event: GaugeEvent, value: string, filesWithValue: Set<string>): "with-value" | "path-only" | null {
  if (event.type !== "tool_call") return null;
  const toolInput = stringify(event.input);
  if (event.tool_kind !== "file_edit") return toolInput.includes(value) && isShellWriteTo(toolInput, filesWithValue) ? "with-value" : null;
  if (toolInput.includes(value)) return "with-value";
  const carriesContent = editContentKeys.some((key) => toolInput.includes(key));
  if (carriesContent) return null;
  return [...filesWithValue].some((file) => toolInput.includes(file)) ? "path-only" : null;
}

function findWriteWindow(orderedEvents: GaugeEvent[], value: string, filesWithValue: Set<string>): { firstWriteSeq: number; lastWriteSeq: number } {
  let firstWriteSeq = Number.POSITIVE_INFINITY;
  let lastWriteSeq = Number.POSITIVE_INFINITY;
  for (const event of orderedEvents) {
    const kind = writeKind(event, value, filesWithValue);
    if (!kind) continue;
    if (firstWriteSeq === Number.POSITIVE_INFINITY) firstWriteSeq = sequenceOf(event);
    lastWriteSeq = sequenceOf(event);
    if (kind === "with-value") return { firstWriteSeq, lastWriteSeq };
  }
  return { firstWriteSeq, lastWriteSeq };
}

function traceProvenance(orderedEvents: GaugeEvent[], value: string, filesWithValue: Set<string>, originMatchers: OriginMatchers): Provenance {
  const { firstWriteSeq, lastWriteSeq } = findWriteWindow(orderedEvents, value, filesWithValue);
  const toolInputById = new Map<string, string>();
  let hasWebEventBeforeWrite = false;
  for (const event of orderedEvents) {
    if (sequenceOf(event) >= lastWriteSeq) break;
    if (event.type === "web_event") hasWebEventBeforeWrite = true;
    if (event.type === "tool_call") toolInputById.set(stringify(event.tool_id), stringify(event.input));
    if (event.type !== "tool_result" || !stringify(event.output).includes(value)) continue;
    const toolInput = toolInputById.get(stringify(event.tool_id)) ?? "";
    return { origin: sightingOrigin(toolInput, originMatchers), seq: sequenceOf(event), isCertain: sequenceOf(event) < firstWriteSeq, toolInput: toolInput.slice(0, 300) };
  }
  if (hasWebEventBeforeWrite) return { origin: "unlogged-web", seq: null, isCertain: false, toolInput: "" };
  return { origin: "none", seq: null, isCertain: true, toolInput: "" };
}

function readFacts(facts: FactsFile | null, events: GaugeEvent[], diff: string): FactReading[] {
  if (!facts) return [];
  const originMatchers = { docs: new RegExp(facts.docsUrlPattern), sdk: new RegExp(facts.sdkPattern) };
  const filesByValueByFact = facts.facts.map((fact) => writtenValues(diff, fact.pattern));
  const orderedEvents = [...events].sort((first, second) => sequenceOf(first) - sequenceOf(second));
  return facts.facts.map((fact, index) => {
    const filesByValue = filesByValueByFact[index] ?? new Map<string, Set<string>>();
    const values = [...filesByValue.keys()];
    const firstValue = values[0];
    return {
      name: fact.name, expected: fact.expected, writtenValues: values,
      passed: values.length === 0 ? null : values.every((value) => value === fact.expected),
      provenance: firstValue === undefined ? null : traceProvenance(orderedEvents, firstValue, filesByValue.get(firstValue) ?? new Set(), originMatchers),
    };
  });
}

function secondsBetween(timestamps: string[]): number | null {
  const times = timestamps.map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite);
  if (times.length < 2) return null;
  return Math.round((Math.max(...times) - Math.min(...times)) / 1000);
}

function buildRow(run: GaugeRun, events: GaugeEvent[], diff: string, facts: FactsFile | null): RunRow {
  const docsMatcher = facts ? new RegExp(facts.docsUrlPattern) : /posthog\.com\/docs/;
  const networkRequests = events.filter((event) => event.type === "network_request");
  const sandboxDocsRequests = networkRequests
    .filter((event) => docsMatcher.test(stringify(event.url)) && stringify(event.method) !== "HEAD")
    .map((event) => {
      const bytes = Number(event.bytes ?? 0);
      return { url: stringify(event.url), bytes, format: docsFormat(stringify(event.url), bytes) };
    });
  const npmTimestamps = networkRequests.filter((event) => event.host === "registry.npmjs.org").map((event) => stringify(event.ts));
  const criteria = run.criterionResults ?? [];
  const comparableCriteria = criteria.filter((criterion) => criterion.name !== docsReadCriterionName);
  const webEvents = events.filter((event) => event.type === "web_event")
    .map((event) => ({ kind: stringify(event.kind), target: stringify(event.url || event.query) }));
  const hasFetchedDocsOnWeb = webEvents.some((event) => event.kind === "fetch" && docsMatcher.test(event.target));
  return {
    runId: run.id, batchId: run.batchId ?? "-", status: run.status, isComplete: terminalStatuses.has(run.status),
    agent: run.agent, model: run.model, creditsCharged: run.creditsCharged ?? null,
    sandboxDocsRequests, webEvents,
    facts: readFacts(facts, events, diff),
    criteriaPassed: criteria.filter((criterion) => criterion.passed === true).length, criteriaTotal: criteria.length,
    failingCriteria: criteria.filter((criterion) => criterion.passed === false).map((criterion) => criterion.name),
    unassessedCriteria: criteria.filter((criterion) => criterion.passed === null).map((criterion) => criterion.name),
    comparableCriteriaPassed: comparableCriteria.filter((criterion) => criterion.passed === true).length,
    comparableCriteriaTotal: comparableCriteria.length,
    hasReachedDocs: sandboxDocsRequests.length > 0 || hasFetchedDocsOnWeb,
    npmWindowSeconds: secondsBetween(npmTimestamps),
    totalSeconds: run.durationMs ? Math.round(run.durationMs / 1000) : null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function docsCell(requests: DocsRequest[]): string {
  if (requests.length === 0) return "0";
  const countByFormat = new Map<string, { count: number; bytes: number }>();
  for (const request of requests) {
    const tally = countByFormat.get(request.format) ?? { count: 0, bytes: 0 };
    countByFormat.set(request.format, { count: tally.count + 1, bytes: Math.max(tally.bytes, request.bytes) });
  }
  return [...countByFormat].map(([format, tally]) => `${tally.count} ${format} ${formatBytes(tally.bytes)}`).join(", ");
}

function factCell(fact: FactReading): string {
  if (fact.passed === null) return "not written";
  const verdict = fact.passed ? "pass" : "FAIL";
  const sighting = fact.provenance;
  const provenance = sighting ? `${sighting.origin}${sighting.seq === null ? "" : `@${sighting.seq}`}${sighting.isCertain ? "" : "?"}` : "none";
  return `${fact.writtenValues.join(" / ")} ${verdict} (from ${provenance})`;
}

function criteriaCell(row: RunRow): string {
  const failing = row.failingCriteria.length ? [`fail: ${row.failingCriteria.join("; ")}`] : [];
  const unassessed = row.unassessedCriteria.length ? [`unassessed: ${row.unassessedCriteria.join("; ")}`] : [];
  const details = [...failing, ...unassessed].join(" / ");
  return `${row.criteriaPassed}/${row.criteriaTotal}${details ? ` ${details}` : ""}`;
}

type GroupTally = {
  batchId: string; agent: string; finishedRuns: number; runningRuns: number; factsPassed: number; factsTotal: number;
  runsReachingDocs: number; criteriaPassed: number; criteriaTotal: number; creditsTotal: number; runsWithCredits: number;
};

function percent(part: number, whole: number): string {
  return whole === 0 ? "-" : `${Math.round((part / whole) * 100)}% (${part}/${whole})`;
}

function renderSummary(rows: RunRow[]): string {
  const tallyByGroup = new Map<string, GroupTally>();
  for (const row of rows) {
    const groupKey = `${row.batchId} ${row.agent}`;
    const tally = tallyByGroup.get(groupKey) ?? {
      batchId: row.batchId, agent: row.agent, finishedRuns: 0, runningRuns: 0, factsPassed: 0, factsTotal: 0,
      runsReachingDocs: 0, criteriaPassed: 0, criteriaTotal: 0, creditsTotal: 0, runsWithCredits: 0,
    };
    tallyByGroup.set(groupKey, tally);
    if (!row.isComplete) {
      tally.runningRuns += 1;
      continue;
    }
    const isSucceeded = row.status === "SUCCEEDED";
    tally.finishedRuns += 1;
    tally.factsTotal += row.facts.length;
    tally.factsPassed += isSucceeded ? row.facts.filter((fact) => fact.passed === true).length : 0;
    tally.runsReachingDocs += row.hasReachedDocs ? 1 : 0;
    tally.criteriaTotal += row.comparableCriteriaTotal;
    tally.criteriaPassed += isSucceeded ? row.comparableCriteriaPassed : 0;
    if (row.creditsCharged === null) continue;
    tally.creditsTotal += row.creditsCharged;
    tally.runsWithCredits += 1;
  }
  const header = ["batch", "agent", "runs", "fact accuracy", "docs reach", `criteria passed (excl. ${docsReadCriterionName})`, "mean credits"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const tally of tallyByGroup.values()) {
    const runs = tally.runningRuns ? `${tally.finishedRuns} (+${tally.runningRuns} running)` : String(tally.finishedRuns);
    const meanCredits = tally.runsWithCredits ? (tally.creditsTotal / tally.runsWithCredits).toFixed(1) : "-";
    lines.push(`| ${[tally.batchId, tally.agent, runs, percent(tally.factsPassed, tally.factsTotal),
      percent(tally.runsReachingDocs, tally.finishedRuns), percent(tally.criteriaPassed, tally.criteriaTotal), meanCredits].join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderTable(rows: RunRow[]): string {
  const factNames = rows[0]?.facts.map((fact) => fact.name) ?? [];
  const header = ["run", "agent", "status", "sandbox docs", "web search/fetch", ...factNames, "criteria", "npm s", "total s"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const searches = row.webEvents.filter((event) => event.kind === "search").length;
    const fetches = row.webEvents.filter((event) => event.kind === "fetch").length;
    const cells = [
      row.runId, `${row.agent} ${row.model}`, row.isComplete ? row.status : `INCOMPLETE ${row.status}`,
      docsCell(row.sandboxDocsRequests), `${searches}/${fetches}`, ...row.facts.map(factCell),
      criteriaCell(row),
      String(row.npmWindowSeconds ?? "-"), String(row.totalSeconds ?? "-"),
    ];
    lines.push(`| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`);
  }
  lines.push("", renderSummary(rows));
  lines.push("", "Not in these logs: content returned by web_event searches and fetches, and the agent's tool roster. Claims about them are inferred.");
  return lines.join("\n");
}

try {
  const options = parseArguments(process.argv.slice(2));
  const runIds = [...options.batchIds.flatMap((batchId) => listBatchRunIds(batchId, options.cacheRoot)), ...options.runIds];
  const rows: RunRow[] = [];
  for (const runId of runIds) {
    const { run, events, diff } = loadRun(runId, options.cacheRoot);
    rows.push(buildRow(run, events, diff, loadFacts(options, run.evalSetId)));
  }
  const outputDirectory = join(options.cacheRoot, [...options.batchIds, ...options.runIds].join("+"));
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "runs.json"), `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`${renderTable(rows)}\nRows: ${join(outputDirectory, "runs.json")}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
