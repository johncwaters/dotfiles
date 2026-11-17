import { spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanUseStateLines } from "./guard.mjs";

const EXPERIMENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIRECTORY = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "dotfiles", "constrain");
const GUARD_PATH = path.join(EXPERIMENT_DIRECTORY, "guard.mjs");
const TARGET_REPOSITORY = path.join(os.homedir(), "Projects", "card-harbor");
const DEPENDENCY_CACHE_DIRECTORY = path.join(os.homedir(), ".cache", "dotfiles-constrain");
const ATTEMPTS_PER_CELL = 2;
const AGENT_TIMEOUT_MS = 90 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_JUDGED_DIFF_CHARACTERS = 60000;
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|\/test\/|\/tests\/|\/e2e\/)/;

const TASKS = [
  { id: "expand-listing-row", referenceCommit: "6268e006" },
  { id: "held-back-copies", referenceCommit: "2944cb07" },
  { id: "card-match-dialog", referenceCommit: "12f784f7" },
];

const SHARED_INSTRUCTIONS = [
  "You are running unattended in a throwaway checkout made for this one task.",
  "Implement the feature completely, with tests where the repo tests similar code.",
  "Before finishing, run `npm run typecheck` and `npx vitest run` and fix what fails.",
  "Do not commit or push, and do not run the specifying, gating-reviews or landing skills.",
].join("\n");

const STATE_RULE = [
  "Constraint: React component state never uses useState.",
  "Hold component state in useReducer with a typed action union, and derive every other value during render.",
].join("\n");

const GUARD_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: `node "${GUARD_PATH}"` }] }],
  },
});

const ARMS = {
  control: { instructions: SHARED_INSTRUCTIONS, settings: null },
  prose: { instructions: `${SHARED_INSTRUCTIONS}\n\n${STATE_RULE}`, settings: null },
  enforced: { instructions: `${SHARED_INSTRUCTIONS}\n\n${STATE_RULE}`, settings: GUARD_SETTINGS },
};

const ROUTE_AROUND_PATTERNS = {
  "useRef holding state": /\buseRef\s*[<(]/,
  "new context": /\bcreateContext\s*[<(]/,
  "external store": /\buseSyncExternalStore\s*\(/,
  "module-level let": /^let\s/,
};

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

function git(args, options = {}) {
  const outcome = run("git", ["-C", TARGET_REPOSITORY, ...args], options);
  if (outcome.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr}`);
  return outcome.stdout;
}

function findTask(taskId) {
  const task = TASKS.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId}; known: ${TASKS.map((candidate) => candidate.id).join(", ")}`);
  return task;
}

function promptFor(task) {
  const commitMessage = git(["show", "-s", "--format=%B", task.referenceCommit]).trim();
  return `Implement this feature in this repository.\n\n${commitMessage}`;
}

function installedDependenciesFor(commit) {
  const lockfileText = git(["show", `${commit}:package-lock.json`]);
  const lockfileHash = createHash("sha256").update(lockfileText).digest("hex").slice(0, 16);
  const installDirectory = path.join(DEPENDENCY_CACHE_DIRECTORY, lockfileHash);
  const nodeModulesDirectory = path.join(installDirectory, "node_modules");
  if (fs.existsSync(path.join(installDirectory, ".installed"))) return nodeModulesDirectory;
  fs.rmSync(installDirectory, { recursive: true, force: true });
  fs.mkdirSync(installDirectory, { recursive: true });
  fs.writeFileSync(path.join(installDirectory, "package.json"), git(["show", `${commit}:package.json`]));
  fs.writeFileSync(path.join(installDirectory, "package-lock.json"), lockfileText);
  console.log(`installing dependencies for lockfile ${lockfileHash} into ${installDirectory}`);
  const install = run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: installDirectory, stdio: "inherit" });
  if (install.status !== 0) throw new Error(`npm ci failed for lockfile ${lockfileHash}`);
  fs.writeFileSync(path.join(installDirectory, ".installed"), "");
  return nodeModulesDirectory;
}

function createWorktree(commit) {
  const nodeModulesDirectory = installedDependenciesFor(commit);
  const worktreeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "constrain-"));
  git(["worktree", "add", "--detach", worktreeDirectory, commit]);
  fs.symlinkSync(nodeModulesDirectory, path.join(worktreeDirectory, "node_modules"));
  return worktreeDirectory;
}

function removeWorktree(worktreeDirectory) {
  run("git", ["-C", TARGET_REPOSITORY, "worktree", "remove", "--force", worktreeDirectory]);
  fs.rmSync(worktreeDirectory, { recursive: true, force: true });
}

function runRepositoryCheck(worktreeDirectory) {
  const typecheck = run("npm", ["run", "typecheck"], { cwd: worktreeDirectory, timeout: CHECK_TIMEOUT_MS });
  const tests = run("npx", ["vitest", "run"], { cwd: worktreeDirectory, timeout: CHECK_TIMEOUT_MS });
  return {
    typecheckExitCode: typecheck.status,
    testExitCode: tests.status,
    passed: typecheck.status === 0 && tests.status === 0,
    failureTail: `${typecheck.stdout}${tests.stdout}${tests.stderr}`.slice(-2000),
  };
}

function agentEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const isSessionMarker = name === "CLAUDE_CODE_SESSION_ATTENDED" || name === "CLAUDECODE" || name.startsWith("GLIMMERVOID");
    if (isSessionMarker) delete environment[name];
  }
  return environment;
}

function runClaude(prompt, { cwd, instructions, settings }) {
  const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--no-session-persistence"];
  if (instructions) args.push("--append-system-prompt", instructions);
  if (settings) args.push("--settings", settings);
  const outcome = run("claude", args, { cwd, input: prompt, env: agentEnvironment(), timeout: AGENT_TIMEOUT_MS });
  if (outcome.error && outcome.error.code !== "ETIMEDOUT") throw new Error(`claude failed to start: ${outcome.error.message}`);
  const lastJsonLine = String(outcome.stdout ?? "").trim().split("\n").filter((line) => line.startsWith("{")).at(-1);
  if (!lastJsonLine) return { isError: true, result: String(outcome.stderr ?? "").slice(-2000), timedOut: outcome.signal === "SIGTERM" };
  const report = JSON.parse(lastJsonLine);
  return { ...report, isError: report.is_error === true, timedOut: false };
}

function measureDiff(diffText) {
  let currentFile = "";
  let removedFile = "";
  const addedSourceLines = [];
  const removedSourceLines = [];
  let changedLineCount = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      removedFile = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile = line === "+++ /dev/null" ? removedFile : line.slice(6);
      continue;
    }
    const isAdded = line.startsWith("+");
    const isRemoved = line.startsWith("-");
    if (!isAdded && !isRemoved) continue;
    changedLineCount++;
    const isProductSource = SOURCE_FILE_RE.test(currentFile) && !TEST_FILE_RE.test(currentFile);
    if (!isProductSource) continue;
    if (isAdded) addedSourceLines.push(line.slice(1));
    if (isRemoved) removedSourceLines.push(line.slice(1));
  }
  const routeArounds = [];
  for (const [kind, pattern] of Object.entries(ROUTE_AROUND_PATTERNS)) {
    const addedMatches = addedSourceLines.filter((line) => pattern.test(line));
    const removedMatches = removedSourceLines.filter((line) => pattern.test(line));
    const netNewCount = addedMatches.length - removedMatches.length;
    if (netNewCount > 0) routeArounds.push({ kind, netNewCount, samples: addedMatches.slice(0, 3).map((line) => line.trim()) });
  }
  return {
    changedLineCount,
    netNewUseState: scanUseStateLines(addedSourceLines.join("\n")).length - scanUseStateLines(removedSourceLines.join("\n")).length,
    routeAroundCount: routeArounds.reduce((sum, routeAround) => sum + routeAround.netNewCount, 0),
    routeArounds,
  };
}

function resultBasename(taskId, armName, attempt) {
  return path.join(RESULTS_DIRECTORY, `${taskId}.${armName}.${attempt}`);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runCell(taskId, armName, attempt) {
  const task = findTask(taskId);
  const arm = ARMS[armName];
  if (!arm) throw new Error(`unknown arm ${armName}; known: ${Object.keys(ARMS).join(", ")}`);
  const basename = resultBasename(taskId, armName, attempt);
  if (fs.existsSync(`${basename}.json`)) {
    console.log(`skip ${taskId} ${armName} ${attempt}: result exists`);
    return;
  }
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  const worktreeDirectory = createWorktree(`${task.referenceCommit}^`);
  try {
    console.log(`run ${taskId} ${armName} ${attempt} in ${worktreeDirectory}`);
    const startedAt = Date.now();
    const agentReport = runClaude(promptFor(task), { cwd: worktreeDirectory, ...arm });
    const wallMs = Date.now() - startedAt;
    const isApiFailure = agentReport.isError && !agentReport.timedOut;
    if (isApiFailure) throw new Error(`agent run errored, cell left for retry: ${String(agentReport.result ?? "").slice(0, 500)}`);
    run("git", ["-C", worktreeDirectory, "add", "-A", "--", ".", ":(exclude)node_modules"]);
    const diffText = run("git", ["-C", worktreeDirectory, "diff", "--cached", "HEAD"]).stdout;
    fs.writeFileSync(`${basename}.diff`, diffText);
    const check = runRepositoryCheck(worktreeDirectory);
    const result = {
      taskId, armName, attempt, wallMs, check,
      ...measureDiff(diffText),
      agent: {
        isError: agentReport.isError,
        timedOut: agentReport.timedOut,
        turns: agentReport.num_turns ?? null,
        durationMs: agentReport.duration_ms ?? null,
        costUsd: agentReport.total_cost_usd ?? null,
        outputTokens: agentReport.usage?.output_tokens ?? null,
        finalMessageTail: String(agentReport.result ?? "").slice(-1500),
      },
    };
    fs.writeFileSync(`${basename}.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`done ${taskId} ${armName} ${attempt}: check ${check.passed ? "pass" : "fail"}, useState ${result.netNewUseState}, route-arounds ${result.routeAroundCount}, ${Math.round(wallMs / 60000)} min`);
  } finally {
    removeWorktree(worktreeDirectory);
  }
}

function probeGuard() {
  const addingPayload = { tool_name: "Write", tool_input: { file_path: "/nonexistent/probe.tsx", content: "const [count, setCount] = useState(0)\n" } };
  const reducerPayload = { tool_name: "Write", tool_input: { file_path: "/nonexistent/probe.tsx", content: "const [state, dispatch] = useReducer(reduce, initialState)\n" } };
  const denied = run("node", [GUARD_PATH], { input: JSON.stringify(addingPayload) }).stdout.includes('"permissionDecision":"deny"');
  const allowed = !run("node", [GUARD_PATH], { input: JSON.stringify(reducerPayload) }).stdout.includes('"permissionDecision":"deny"');
  console.log(`guard probe: adding useState ${denied ? "denied" : "NOT denied"}, useReducer ${allowed ? "allowed" : "NOT allowed"}`);
  return denied && allowed;
}

function runBaselines() {
  let isEveryBaselineGreen = probeGuard();
  for (const task of TASKS) {
    const worktreeDirectory = createWorktree(`${task.referenceCommit}^`);
    try {
      const check = runRepositoryCheck(worktreeDirectory);
      console.log(`baseline ${task.id} at ${task.referenceCommit}^: typecheck ${check.typecheckExitCode}, tests ${check.testExitCode}`);
      if (!check.passed) console.log(check.failureTail);
      isEveryBaselineGreen = isEveryBaselineGreen && check.passed;
    } finally {
      removeWorktree(worktreeDirectory);
    }
  }
  return isEveryBaselineGreen;
}

function referenceDiffFor(task) {
  return git(["show", "--format=", task.referenceCommit, "--", ".", ":(exclude)package-lock.json"]);
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function judgeAttempt(task, attempt) {
  const judgementPath = path.join(RESULTS_DIRECTORY, `${task.id}.${attempt}.judge.json`);
  if (fs.existsSync(judgementPath)) return;
  const armNames = Object.keys(ARMS);
  const isEveryArmDone = armNames.every((armName) => fs.existsSync(`${resultBasename(task.id, armName, attempt)}.diff`));
  if (!isEveryArmDone) return;
  const labels = ["A", "B", "C"];
  const armByLabel = Object.fromEntries(shuffled(armNames).map((armName, index) => [labels[index], armName]));
  const candidates = labels.map((label) => {
    const diffText = fs.readFileSync(`${resultBasename(task.id, armByLabel[label], attempt)}.diff`, "utf8");
    return `## Candidate ${label}\n\`\`\`diff\n${diffText.slice(0, MAX_JUDGED_DIFF_CHARACTERS)}\n\`\`\``;
  });
  const judgePrompt = [
    "You are judging three independent implementations of the same feature in a React + TypeScript Electron app.",
    `The feature request:\n\n${promptFor(task)}`,
    `The reference implementation that shipped:\n\`\`\`diff\n${referenceDiffFor(task).slice(0, MAX_JUDGED_DIFF_CHARACTERS)}\n\`\`\``,
    ...candidates,
    "Rank the candidates best to worst on: does it implement the requested behavior correctly and completely, is the state handling simple and correct, and is the code clear and no larger than needed. Do not run tools; judge from the diffs.",
    'Reply with only a JSON object: {"ranking": ["<best label>", "<middle label>", "<worst label>"], "reasons": {"A": "<one sentence>", "B": "<one sentence>", "C": "<one sentence>"}}',
  ].join("\n\n");
  const judgeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "constrain-judge-"));
  try {
    const report = runClaude(judgePrompt, { cwd: judgeDirectory, instructions: null, settings: null });
    const jsonText = String(report.result ?? "").match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) throw new Error(`judge for ${task.id} attempt ${attempt} returned no JSON: ${String(report.result).slice(0, 500)}`);
    const verdict = JSON.parse(jsonText);
    const isRankingPermutation = Array.isArray(verdict.ranking) && verdict.ranking.length === labels.length && labels.every((label) => verdict.ranking.includes(label));
    if (!isRankingPermutation) throw new Error(`judge for ${task.id} attempt ${attempt} returned ranking ${JSON.stringify(verdict.ranking)}, not a permutation of ${labels.join(",")}`);
    const judgement = { taskId: task.id, attempt, ranking: verdict.ranking, reasons: verdict.reasons, armByLabel, costUsd: report.total_cost_usd ?? null };
    fs.writeFileSync(judgementPath, `${JSON.stringify(judgement, null, 2)}\n`);
    console.log(`judged ${task.id} ${attempt}: ${verdict.ranking.map((label) => armByLabel[label]).join(" > ")}`);
  } finally {
    fs.rmSync(judgeDirectory, { recursive: true, force: true });
  }
}

function judgeAll() {
  for (const task of TASKS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_CELL; attempt++) judgeAttempt(task, attempt);
  }
}

function rankOf(judgement, armName) {
  const label = Object.entries(judgement.armByLabel).find(([, judgedArm]) => judgedArm === armName)?.[0];
  const position = judgement.ranking.indexOf(label);
  if (position < 0) throw new Error(`judgement ${judgement.taskId}.${judgement.attempt} does not rank ${armName}`);
  return position + 1;
}

function decideVerdict(totalsByArm, bestArmByTask) {
  const tasksEnforcedWon = Object.values(bestArmByTask).filter((armName) => armName === "enforced").length;
  const tasksControlWon = Object.values(bestArmByTask).filter((armName) => armName === "control").length;
  const isEnforcedPassingAsOften = totalsByArm.enforced.checksPassed >= totalsByArm.control.checksPassed;
  const enforcedEvasions = totalsByArm.enforced.routeArounds + Math.max(0, totalsByArm.enforced.netNewUseState);
  const isEnforcedNoMoreRoutedAround = enforcedEvasions <= totalsByArm.control.routeArounds;
  if (isEnforcedPassingAsOften && isEnforcedNoMoreRoutedAround && tasksEnforcedWon >= 2) return "win";
  if (!isEnforcedPassingAsOften || tasksControlWon >= 2) return "loss";
  return "tie";
}

function report() {
  const armNames = Object.keys(ARMS);
  const missing = [];
  const rows = [];
  const totalsByArm = Object.fromEntries(armNames.map((armName) => [armName, { checksPassed: 0, routeArounds: 0, netNewUseState: 0, rankSum: 0, costUsd: 0, wallMs: 0 }]));
  const bestArmByTask = {};
  for (const task of TASKS) {
    const rankSumByArm = Object.fromEntries(armNames.map((armName) => [armName, 0]));
    for (let attempt = 1; attempt <= ATTEMPTS_PER_CELL; attempt++) {
      const judgement = readJson(path.join(RESULTS_DIRECTORY, `${task.id}.${attempt}.judge.json`));
      if (!judgement) missing.push(`${task.id}.${attempt}.judge.json`);
      for (const armName of armNames) {
        const result = readJson(`${resultBasename(task.id, armName, attempt)}.json`);
        if (!result) {
          missing.push(`${task.id}.${armName}.${attempt}.json`);
          continue;
        }
        const rank = judgement ? rankOf(judgement, armName) : null;
        rankSumByArm[armName] += rank ?? 0;
        const totals = totalsByArm[armName];
        totals.checksPassed += result.check.passed ? 1 : 0;
        totals.routeArounds += result.routeAroundCount;
        totals.netNewUseState += result.netNewUseState;
        totals.rankSum += rank ?? 0;
        totals.costUsd += result.agent.costUsd ?? 0;
        totals.wallMs += result.wallMs;
        rows.push(`| ${task.id} | ${armName} | ${attempt} | ${result.check.passed ? "pass" : "FAIL"} | ${result.netNewUseState} | ${result.routeAroundCount} | ${result.changedLineCount} | ${result.agent.turns ?? "?"} | ${(result.agent.costUsd ?? 0).toFixed(2)} | ${Math.round(result.wallMs / 60000)} | ${rank ?? "?"} |`);
      }
    }
    const lowestRankSum = Math.min(...Object.values(rankSumByArm));
    const armsAtLowest = armNames.filter((armName) => rankSumByArm[armName] === lowestRankSum);
    bestArmByTask[task.id] = armsAtLowest.length === 1 ? armsAtLowest[0] : "tied";
  }
  console.log("| task | arm | attempt | check | net useState | route-arounds | changed lines | turns | cost $ | min | judge rank |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log("\n| arm | checks passed | net useState | route-arounds | rank sum | cost $ | hours |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [armName, totals] of Object.entries(totalsByArm)) {
    console.log(`| ${armName} | ${totals.checksPassed} | ${totals.netNewUseState} | ${totals.routeArounds} | ${totals.rankSum} | ${totals.costUsd.toFixed(2)} | ${(totals.wallMs / 3600000).toFixed(1)} |`);
  }
  console.log(`\nbest arm per task: ${Object.entries(bestArmByTask).map(([taskId, armName]) => `${taskId}=${armName}`).join(", ")}`);
  if (missing.length > 0) {
    console.log(`\nmissing ${missing.length}: ${missing.join(", ")}`);
    return false;
  }
  console.log(`verdict: ${decideVerdict(totalsByArm, bestArmByTask)}`);
  return true;
}

function runAll() {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CELL; attempt++) {
    for (const task of TASKS) {
      for (const armName of Object.keys(ARMS)) runCell(task.id, armName, attempt);
    }
  }
  judgeAll();
  return report();
}

const [mode, ...modeArguments] = process.argv.slice(2);
const modes = {
  "--baselines": () => runBaselines(),
  "--run": () => {
    runCell(modeArguments[0], modeArguments[1], Number(modeArguments[2]));
    return true;
  },
  "--judge": () => {
    judgeAll();
    return true;
  },
  "--report": () => report(),
  "--all": () => runAll(),
};
const selectedMode = modes[mode];
if (!selectedMode) {
  console.error(`usage: node run.mjs ${Object.keys(modes).join(" | ")}  (--run <task> <arm> <attempt>)`);
  process.exit(2);
}
process.exit(selectedMode() ? 0 : 1);
