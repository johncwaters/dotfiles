import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ReaderOptions = { batchIds: string[]; runIds: string[]; factsPath?: string; cacheRoot: string };
type GaugeEvent = Record<string, unknown> & { type: string; seq?: number | string; ts?: string };
type CriterionResult = { name: string; passed: boolean | null };
type GaugeRun = {
  id: string; status: string; agent: string; model: string; batchId?: string; evalSetId?: string; promptText?: string;
  durationMs?: number; creditsCharged?: number | null; criterionResults?: CriterionResult[];
};
type FactDefinition = { name: string; pattern: string; expected: string | string[] };
type FactsFile = { promptPattern?: string; docsUrlPattern: string; sdkPattern: string; facts: FactDefinition[] };
type LoadedFactsFile = FactsFile & { fileName: string };
type Provenance = {
  origin: "docs" | "sdk" | "mcp" | "skill" | "other" | "unlogged-web" | "unlogged-skill" | "none"; seq: number | null; isCertain: boolean; toolInput: string;
};
type ValueReading = { value: string; passed: boolean; provenance: Provenance };
type FactReading = { name: string; expected: string[]; writtenValues: string[]; passed: boolean | null; values: ValueReading[] };
type DocsTiming = {
  firstDocsSeq: number | null; firstPosthogWriteSeq: number | null;
  timing: "before-write" | "after-write" | "never" | "no-write"; hasRelevantResult: boolean | null;
};
type DocsQuery = { seq: number; source: "mcp" | "web"; query: string; hasExpectedValue: boolean | null };
type Recovery = { checksRun: number; errors: number; queriesAfterFirstError: number };
type DocsRequest = { url: string; bytes: number; format: string };
type WorksCheck = {
  envNamesInCode: string[]; envNamesMissingFromEnvFiles: string[]; envNamesMissingFromFinalMessage: string[];
  proxyRoute: "rewrites" | "rewriteRequestPath" | "unrouted" | null;
};
type RunRow = {
  runId: string; batchId: string; promptText: string; mcpDigest: string | null; skillsDigest: string | null;
  docsTiming: DocsTiming; skillsLoaded: string[]; docsQueries: DocsQuery[]; recovery: Recovery; status: string; isComplete: boolean; agent: string; model: string;
  creditsCharged: number | null; sandboxDocsRequests: DocsRequest[]; mcpDocsSearches: number; webEvents: { kind: string; target: string }[];
  facts: FactReading[]; worksCheck: WorksCheck; docsPagesFetched: string[]; installedPosthogJsVersion: string | null;
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

function readFactsFile(factsPath: string): LoadedFactsFile {
  return { ...(JSON.parse(readFileSync(factsPath, "utf8")) as FactsFile), fileName: factsPath };
}

function loadFactsFiles(options: ReaderOptions): LoadedFactsFile[] {
  if (options.factsPath) return [readFactsFile(options.factsPath)];
  const factsDirectory = join(skillDirectory, "facts");
  return readdirSync(factsDirectory).filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readFactsFile(join(factsDirectory, fileName)));
}

function selectFacts(factsFiles: LoadedFactsFile[], run: GaugeRun, options: ReaderOptions): FactsFile | null {
  if (options.factsPath) return factsFiles[0] ?? null;
  const promptMatch = factsFiles.find((factsFile) => factsFile.promptPattern && new RegExp(factsFile.promptPattern).test(run.promptText ?? ""));
  if (promptMatch) return promptMatch;
  return factsFiles.find((factsFile) => run.evalSetId && factsFile.fileName.endsWith(`/${run.evalSetId}.json`)) ?? null;
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

function addedLinesByFile(diff: string): Map<string, string[]> {
  const linesByFile = new Map<string, string[]>();
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    linesByFile.set(currentFile, [...(linesByFile.get(currentFile) ?? []), line.slice(1)]);
  }
  return linesByFile;
}

function writtenValues(diff: string, pattern: string): Map<string, Set<string>> {
  const filesByValue = new Map<string, Set<string>>();
  const matcher = new RegExp(pattern, "g");
  for (const [file, lines] of addedLinesByFile(diff)) {
    for (const match of lines.flatMap((line) => [...line.matchAll(matcher)])) {
      if (!match[1]) continue;
      filesByValue.set(match[1], (filesByValue.get(match[1]) ?? new Set()).add(file));
    }
  }
  return filesByValue;
}

const posthogEnvNamePattern = /NEXT_PUBLIC_POSTHOG_[A-Z_]+/g;
const envFilePattern = /(^|\/)\.env[^/]*$/;
const sourceFilePattern = /\.(c|m)?[jt]sx?$/;

function namesMatching(lines: string[], pattern: RegExp): Set<string> {
  return new Set(lines.flatMap((line) => [...line.matchAll(pattern)].map((match) => match[1] ?? match[0])));
}

function proxyRoute(linesByFile: Map<string, string[]>): WorksCheck["proxyRoute"] {
  const allLines = [...linesByFile.values()].flat();
  if (allLines.some((line) => line.includes("rewriteRequestPath"))) return "rewriteRequestPath";
  const apiHostPath = allLines.map((line) => line.match(/api_host:\s*["'`](\/[^"'`]*)["'`]/)?.[1]).find(Boolean);
  if (!apiHostPath) return null;
  const nextConfigLines = [...linesByFile].filter(([file]) => /(^|\/)next\.config\./.test(file)).flatMap(([, lines]) => lines);
  const rewriteSources = namesMatching(nextConfigLines, /source:\s*["'`](\/[^"'`]*)["'`]/g);
  return [...rewriteSources].some((source) => source.startsWith(apiHostPath)) ? "rewrites" : "unrouted";
}

function checkWorks(diff: string, finalMessage: string): WorksCheck {
  const linesByFile = addedLinesByFile(diff);
  const sourceLines = [...linesByFile].filter(([file]) => sourceFilePattern.test(file)).flatMap(([, lines]) => lines);
  const envNamesInCode = [...namesMatching(sourceLines, /process\.env\.(NEXT_PUBLIC_POSTHOG_[A-Z_]+)/g)];
  const envFileNameSets = [...linesByFile].filter(([file]) => envFilePattern.test(file))
    .map(([, lines]) => namesMatching(lines, /^\s*(NEXT_PUBLIC_POSTHOG_[A-Z_]+)\s*=/g));
  const finalMessageNames = namesMatching([finalMessage], posthogEnvNamePattern);
  return {
    envNamesInCode,
    envNamesMissingFromEnvFiles: envNamesInCode.filter((name) => envFileNameSets.some((names) => !names.has(name))),
    envNamesMissingFromFinalMessage: envNamesInCode.filter((name) => !finalMessageNames.has(name)),
    proxyRoute: proxyRoute(linesByFile),
  };
}

function installedPosthogJsVersion(diff: string): string | null {
  return diff.match(/^\+\s*"posthog-js":\s*"([^"]+)"/m)?.[1] ?? null;
}

type OriginMatchers = { docs: RegExp; sdk: RegExp };

const skillLoadPattern = /"skill":\s*"([^"]+)"|\.(?:claude|codex|agents)\/skills\/([^/\s'"]+)\//;

function loadedSkillName(event: GaugeEvent): string | null {
  if (event.type !== "tool_call") return null;
  const match = stringify(event.input).match(skillLoadPattern);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function sightingOrigin(toolInput: string, originMatchers: OriginMatchers): Provenance["origin"] {
  if (skillLoadPattern.test(toolInput)) return "skill";
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

function isMcpCall(event: GaugeEvent): boolean {
  return event.type === "tool_call" && event.tool_kind === "mcp";
}

function traceProvenance(orderedEvents: GaugeEvent[], value: string, filesWithValue: Set<string>, originMatchers: OriginMatchers): Provenance {
  const { firstWriteSeq, lastWriteSeq } = findWriteWindow(orderedEvents, value, filesWithValue);
  const toolCallById = new Map<string, { toolInput: string; isMcp: boolean }>();
  let hasWebEventBeforeWrite = false;
  let hasSkillLoadBeforeWrite = false;
  for (const event of orderedEvents) {
    if (sequenceOf(event) >= lastWriteSeq) break;
    if (event.type === "web_event") hasWebEventBeforeWrite = true;
    if (loadedSkillName(event) !== null) hasSkillLoadBeforeWrite = true;
    if (event.type === "tool_call") {
      const toolCall = { toolInput: stringify(event.input), isMcp: isMcpCall(event) };
      toolCallById.set(stringify(event.tool_id), toolCall);
      if (toolCall.isMcp && toolCall.toolInput.includes(value)) {
        return { origin: "mcp", seq: sequenceOf(event), isCertain: sequenceOf(event) < firstWriteSeq, toolInput: toolCall.toolInput.slice(0, 300) };
      }
    }
    if (event.type !== "tool_result" || !stringify(event.output).includes(value)) continue;
    const toolCall = toolCallById.get(stringify(event.tool_id)) ?? { toolInput: "", isMcp: false };
    const origin = toolCall.isMcp ? "mcp" : sightingOrigin(toolCall.toolInput, originMatchers);
    return { origin, seq: sequenceOf(event), isCertain: sequenceOf(event) < firstWriteSeq, toolInput: toolCall.toolInput.slice(0, 300) };
  }
  if (hasWebEventBeforeWrite) return { origin: "unlogged-web", seq: null, isCertain: false, toolInput: "" };
  if (hasSkillLoadBeforeWrite) return { origin: "unlogged-skill", seq: null, isCertain: false, toolInput: "" };
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
    const expectedValues = [fact.expected].flat();
    return {
      name: fact.name, expected: expectedValues, writtenValues: values,
      passed: values.length === 0 ? null : values.every((value) => expectedValues.includes(value)),
      values: values.map((value) => ({
        value, passed: expectedValues.includes(value),
        provenance: traceProvenance(orderedEvents, value, filesByValue.get(value) ?? new Set(), originMatchers),
      })),
    };
  });
}

const posthogWritePattern = /posthog/i;
const packageInstallPattern = /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b[^\n]*posthog/;
const buildCheckPattern = /\b(build|lint|tsc|typecheck|test)\b/;

function isMcpDocsCall(event: GaugeEvent): boolean {
  return isMcpCall(event) && /^(call docs-search|learn)\b/.test(mcpCommand(event));
}

function isPosthogWrite(event: GaugeEvent): boolean {
  if (event.type !== "tool_call") return false;
  const toolInput = stringify(event.input);
  if (event.tool_kind === "file_edit") return posthogWritePattern.test(toolInput);
  return event.tool_kind === "shell" && packageInstallPattern.test(toolInput);
}

function mcpCommand(event: GaugeEvent): string {
  const input = (event.input ?? {}) as { command?: unknown; arguments?: { command?: unknown } };
  return stringify(input.command ?? input.arguments?.command);
}

function callResultText(event: GaugeEvent, resultById: Map<string, string>): string {
  const embeddedResult = (event.input as { result?: unknown } | undefined)?.result;
  return resultById.get(stringify(event.tool_id)) ?? (embeddedResult === undefined ? "" : stringify(embeddedResult));
}

function mcpQueryText(event: GaugeEvent): string {
  const command = mcpCommand(event);
  return command.match(/"query":\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? command.match(/learn\s+-s\s+"([^"]*)"/)?.[1] ?? command;
}

function webQueryText(event: GaugeEvent): string {
  const input = (event.input ?? {}) as { query?: unknown; url?: unknown; action?: { queries?: unknown[] } };
  const queries = input.action?.queries?.map(stringify) ?? [];
  return queries.length ? queries.join(" ; ") : stringify(input.query ?? input.url);
}

function readDocsQueries(orderedEvents: GaugeEvent[], resultById: Map<string, string>, expectedValues: string[]): DocsQuery[] {
  const resultHasExpected = (event: GaugeEvent): boolean => expectedValues.some((value) => callResultText(event, resultById).includes(value));
  return orderedEvents.flatMap((event): DocsQuery[] => {
    if (isMcpDocsCall(event)) return [{ seq: sequenceOf(event), source: "mcp", query: mcpQueryText(event), hasExpectedValue: resultHasExpected(event) }];
    if (event.type === "tool_call" && event.tool_kind === "web") return [{ seq: sequenceOf(event), source: "web", query: webQueryText(event), hasExpectedValue: callResultText(event, resultById) === "" ? null : resultHasExpected(event) }];
    return [];
  });
}

function readDocsTiming(orderedEvents: GaugeEvent[], docsMatcher: RegExp, resultById: Map<string, string>, expectedValues: string[]): DocsTiming {
  const docsEvents = orderedEvents.filter((event) => isMcpDocsCall(event)
    || (event.type === "tool_call" && docsMatcher.test(stringify(event.input)))
    || (event.type === "network_request" && docsMatcher.test(stringify(event.url)) && stringify(event.method) !== "HEAD")
    || (event.type === "web_event" && docsMatcher.test(stringify(event.url || event.query))));
  const firstDocsSeq = docsEvents[0] ? sequenceOf(docsEvents[0]) : null;
  const firstPosthogWrite = orderedEvents.find(isPosthogWrite);
  const firstPosthogWriteSeq = firstPosthogWrite ? sequenceOf(firstPosthogWrite) : null;
  const loggedDocsResults = docsEvents.filter((event) => event.type === "tool_call")
    .map((event) => callResultText(event, resultById)).filter((resultText) => resultText !== "");
  const hasRelevantResult = loggedDocsResults.length === 0
    ? null
    : loggedDocsResults.some((resultText) => expectedValues.some((value) => resultText.includes(value)));
  const timing = (): DocsTiming["timing"] => {
    if (firstDocsSeq === null) return "never";
    if (firstPosthogWriteSeq === null) return "no-write";
    return firstDocsSeq < firstPosthogWriteSeq ? "before-write" : "after-write";
  };
  return { firstDocsSeq, firstPosthogWriteSeq, timing: timing(), hasRelevantResult };
}

function readRecovery(orderedEvents: GaugeEvent[], docsQueries: DocsQuery[]): Recovery {
  const firstError = orderedEvents.find((event) => event.type === "tool_result" && event.is_error === true);
  const firstErrorSeq = firstError ? sequenceOf(firstError) : Number.POSITIVE_INFINITY;
  return {
    checksRun: orderedEvents.filter((event) => event.type === "tool_call" && event.tool_kind === "shell" && buildCheckPattern.test(stringify(event.input))).length,
    errors: orderedEvents.filter((event) => event.type === "tool_result" && event.is_error === true).length,
    queriesAfterFirstError: docsQueries.filter((query) => query.seq > firstErrorSeq).length,
  };
}

function harnessDigest(events: GaugeEvent[], action: string, key: string): string | null {
  const harnessEvent = events.find((event) => event.type === "harness_action" && event.action === action);
  const digest = (harnessEvent?.[key] as { digest?: unknown } | undefined)?.digest;
  return typeof digest === "string" ? digest : null;
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
  const mcpDocsSearches = events.filter((event) => isMcpCall(event) && /\bcall docs-search\b/.test(stringify(event.input))).length;
  const fetchedDocsTargets = webEvents.filter((event) => event.kind === "fetch" && docsMatcher.test(event.target)).map((event) => event.target);
  const finalMessage = stringify(events.filter((event) => event.type === "agent_message").at(-1)?.text);
  const orderedEvents = [...events].sort((first, second) => sequenceOf(first) - sequenceOf(second));
  const resultById = new Map(events.filter((event) => event.type === "tool_result").map((event) => [stringify(event.tool_id), stringify(event.output)]));
  const expectedValues = facts?.facts.flatMap((fact) => [fact.expected].flat()) ?? [];
  const docsQueries = readDocsQueries(orderedEvents, resultById, expectedValues);
  return {
    runId: run.id, batchId: run.batchId ?? "-", promptText: run.promptText ?? "",
    mcpDigest: harnessDigest(events, "mcp_prepared", "mcp"), skillsDigest: harnessDigest(events, "skills_staged", "skills"),
    docsTiming: readDocsTiming(orderedEvents, docsMatcher, resultById, expectedValues),
    skillsLoaded: [...new Set(orderedEvents.map(loadedSkillName).filter((name): name is string => name !== null))],
    docsQueries, recovery: readRecovery(orderedEvents, docsQueries),
    status: run.status, isComplete: terminalStatuses.has(run.status),
    agent: run.agent, model: run.model, creditsCharged: run.creditsCharged ?? null,
    sandboxDocsRequests, mcpDocsSearches, webEvents,
    facts: readFacts(facts, events, diff),
    worksCheck: checkWorks(diff, finalMessage),
    docsPagesFetched: [...new Set([...sandboxDocsRequests.map((request) => request.url), ...fetchedDocsTargets])],
    installedPosthogJsVersion: installedPosthogJsVersion(diff),
    criteriaPassed: criteria.filter((criterion) => criterion.passed === true).length, criteriaTotal: criteria.length,
    failingCriteria: criteria.filter((criterion) => criterion.passed === false).map((criterion) => criterion.name),
    unassessedCriteria: criteria.filter((criterion) => criterion.passed === null).map((criterion) => criterion.name),
    comparableCriteriaPassed: comparableCriteria.filter((criterion) => criterion.passed === true).length,
    comparableCriteriaTotal: comparableCriteria.length,
    hasReachedDocs: sandboxDocsRequests.length > 0 || hasFetchedDocsOnWeb || mcpDocsSearches > 0,
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
  return fact.values.map(({ value, passed, provenance: sighting }) => {
    const provenance = `${sighting.origin}${sighting.seq === null ? "" : `@${sighting.seq}`}${sighting.isCertain ? "" : "?"}`;
    return `${value} ${passed ? "pass" : "FAIL"} (from ${provenance})`;
  }).join(" / ");
}

function docsTimingCell(docsTiming: DocsTiming): string {
  const relevance = docsTiming.hasRelevantResult === null ? "" : docsTiming.hasRelevantResult ? " relevant" : " irrelevant";
  const firstDocs = docsTiming.firstDocsSeq === null ? "" : `@${docsTiming.firstDocsSeq}`;
  return `${docsTiming.timing}${firstDocs}${relevance}`;
}

function skillsCell(row: RunRow): string {
  if (row.skillsLoaded.length === 0) return "-";
  const origins = new Set(row.facts.flatMap((fact) => fact.values.map((reading) => reading.provenance.origin)));
  const followed = origins.has("skill") ? " (followed)" : origins.has("unlogged-skill") ? " (content unlogged)" : "";
  return `${row.skillsLoaded.join(", ")}${followed}`;
}

function queriesCell(queries: DocsQuery[]): string {
  if (queries.length === 0) return "0";
  const hits = queries.filter((query) => query.hasExpectedValue === true).length;
  return `${queries.length} (${hits} with expected value)`;
}

function recoveryCell(recovery: Recovery): string {
  return `checks ${recovery.checksRun}, errors ${recovery.errors}, queries after error ${recovery.queriesAfterFirstError}`;
}

function worksCell(check: WorksCheck): string {
  const envProblems = [
    ...(check.envNamesMissingFromEnvFiles.length ? [`not in .env: ${check.envNamesMissingFromEnvFiles.join(", ")}`] : []),
    ...(check.envNamesMissingFromFinalMessage.length ? [`not in final message: ${check.envNamesMissingFromFinalMessage.join(", ")}`] : []),
  ];
  const envCell = check.envNamesInCode.length === 0 ? "env -" : `env ${envProblems.length ? envProblems.join("; ") : "ok"}`;
  return `${envCell} / proxy ${check.proxyRoute ?? "-"}`;
}

function criteriaCell(row: RunRow): string {
  const failing = row.failingCriteria.length ? [`fail: ${row.failingCriteria.join("; ")}`] : [];
  const unassessed = row.unassessedCriteria.length ? [`unassessed: ${row.unassessedCriteria.join("; ")}`] : [];
  const details = [...failing, ...unassessed].join(" / ");
  return `${row.criteriaPassed}/${row.criteriaTotal}${details ? ` ${details}` : ""}`;
}

type CellTally = {
  task: string; setup: string; agent: string; batchIds: Set<string>; finishedRuns: number; runningRuns: number;
  factsPassed: number; factsTotal: number; runsReachingDocs: number; criteriaPassed: number; criteriaTotal: number;
  creditsTotal: number; runsWithCredits: number; docsTimings: Set<string>; skillSets: Set<string>;
};

const fullCellRuns = 5;

function percent(part: number, whole: number): string {
  return whole === 0 ? "-" : `${Math.round((part / whole) * 100)}% (${part}/${whole})`;
}

function setupLabel(row: RunRow): string {
  const parts = [
    ...(row.mcpDigest ? [`mcp ${row.mcpDigest.slice(7, 15)}`] : []),
    ...(row.skillsDigest ? [`skills ${row.skillsDigest.slice(7, 15)}`] : []),
  ];
  return parts.length ? parts.join(" + ") : "none";
}

function taskLabel(promptText: string): string {
  if (!promptText) return "-";
  return promptText.length > 40 ? `${promptText.slice(0, 40)}...` : promptText;
}

function needsTopUp(tally: CellTally): boolean {
  if (tally.finishedRuns < 2 || tally.finishedRuns >= fullCellRuns) return false;
  return tally.docsTimings.size > 1 || tally.skillSets.size > 1;
}

function renderSummary(rows: RunRow[]): string {
  const tallyByCell = new Map<string, CellTally>();
  for (const row of rows) {
    const cellKey = [row.promptText, row.mcpDigest, row.skillsDigest, row.agent].join(" ");
    const tally = tallyByCell.get(cellKey) ?? {
      task: taskLabel(row.promptText), setup: setupLabel(row), agent: row.agent, batchIds: new Set<string>(),
      finishedRuns: 0, runningRuns: 0, factsPassed: 0, factsTotal: 0, runsReachingDocs: 0, criteriaPassed: 0, criteriaTotal: 0,
      creditsTotal: 0, runsWithCredits: 0, docsTimings: new Set<string>(), skillSets: new Set<string>(),
    };
    tallyByCell.set(cellKey, tally);
    tally.batchIds.add(row.batchId);
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
    tally.docsTimings.add(row.docsTiming.timing);
    tally.skillSets.add([...row.skillsLoaded].sort().join(","));
    if (row.creditsCharged === null) continue;
    tally.creditsTotal += row.creditsCharged;
    tally.runsWithCredits += 1;
  }
  const header = ["task", "setup", "agent", "batches", "runs", "fact accuracy", "docs reach", `criteria passed (excl. ${docsReadCriterionName})`, "mean credits", "top-up"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const tally of tallyByCell.values()) {
    const runs = tally.runningRuns ? `${tally.finishedRuns} (+${tally.runningRuns} running)` : String(tally.finishedRuns);
    const meanCredits = tally.runsWithCredits ? (tally.creditsTotal / tally.runsWithCredits).toFixed(1) : "-";
    const topUp = needsTopUp(tally) ? `yes (+${fullCellRuns - tally.finishedRuns})` : "no";
    lines.push(`| ${[tally.task, tally.setup, tally.agent, [...tally.batchIds].join(" "), runs, percent(tally.factsPassed, tally.factsTotal),
      percent(tally.runsReachingDocs, tally.finishedRuns), percent(tally.criteriaPassed, tally.criteriaTotal), meanCredits, topUp]
      .map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderTable(rows: RunRow[]): string {
  const factNames = [...new Set(rows.flatMap((row) => row.facts.map((fact) => fact.name)))];
  const header = ["run", "agent", "status", "sandbox docs", "mcp docs-search", "web search/fetch", ...factNames, "docs timing", "docs queries", "skills loaded", "works check", "docs pages", "posthog-js", "recovery", "criteria", "npm s", "total s"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const searches = row.webEvents.filter((event) => event.kind === "search").length;
    const fetches = row.webEvents.filter((event) => event.kind === "fetch").length;
    const cells = [
      row.runId, `${row.agent} ${row.model}`, row.isComplete ? row.status : `INCOMPLETE ${row.status}`,
      docsCell(row.sandboxDocsRequests), String(row.mcpDocsSearches), `${searches}/${fetches}`, ...factNames.map((name) => {
        const fact = row.facts.find((candidate) => candidate.name === name);
        return fact ? factCell(fact) : "-";
      }),
      docsTimingCell(row.docsTiming), queriesCell(row.docsQueries), skillsCell(row),
      worksCell(row.worksCheck), row.docsPagesFetched.map((url) => url.replace(/^https?:\/\/(www\.)?/, "")).join(" ") || "-",
      row.installedPosthogJsVersion ?? "-", recoveryCell(row.recovery),
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
  const factsFiles = loadFactsFiles(options);
  const rows: RunRow[] = [];
  for (const runId of runIds) {
    const { run, events, diff } = loadRun(runId, options.cacheRoot);
    rows.push(buildRow(run, events, diff, selectFacts(factsFiles, run, options)));
  }
  const outputDirectory = join(options.cacheRoot, [...options.batchIds, ...options.runIds].join("+"));
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "runs.json"), `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`${renderTable(rows)}\nRows: ${join(outputDirectory, "runs.json")}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
