import fs from "node:fs";
import path from "node:path";

export type Goal = {
  id: "G1";
  kind: "goal";
  text: string;
  risk?: "low" | "medium" | "high" | "critical";
  criteria?: string[];
};
export type NonGoal = { id: `N${number}`; kind: "nonGoal"; text: string };
export type Branch = { id: `B${number}`; kind: "branch"; question: string; leaning: string };
export type Decision = {
  id: `D${number}`;
  kind: "decision";
  question: string;
  answer: string;
  why: string;
  source: "decided" | "read" | "assumed";
  evidence?: string;
  isConstraint?: boolean;
};
export type OpenQuestion = { id: `Q${number}`; kind: "openQuestion"; question: string; settledBy: string };
export type Unit = {
  id: `U${number}`;
  kind: "unit";
  title: string;
  reads: string[];
  changes: string[];
  checks: { run: string }[];
  serves?: number[];
  budgetWaiver?: string;
};
export type Design = {
  id: `I${number}`;
  kind: "design";
  layer: "behavior" | "architecture" | "program";
  title: string;
  code: string;
  at?: string;
};
export type Node = Goal | NonGoal | Branch | Decision | OpenQuestion | Unit | Design;
export type EdgeKind = "blocks" | "implements" | "dependsOn" | "deferredBy";
export type Edge = { from: Node["id"]; kind: EdgeKind; to: Node["id"] };
export type DesignSpec = {
  status: "sketch" | "grilled" | "sliced" | "challenged";
  request: string;
  repoRoot: string;
  nodes: Node[];
  edges: Edge[];
  challengeStamp?: string;
  challengedUnitIds?: string[];
};

export const READING_BUDGET_BYTES = 200000;
const UNIT_TITLE_LIMIT = 120;

export function oneLine(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

export function unitTicketCriteria(unit: Unit, goalCriteria: string[]): string[] {
  return [...new Set([
    oneLine(unit.title),
    ...(unit.serves ?? []).map((criterionNumber) => oneLine(goalCriteria[criterionNumber - 1] ?? "")),
    ...unit.checks.map((check) => oneLine(`The command ${check.run} exits 0.`)),
  ])];
}

const NODE_FIELDS = {
  goal: ["id", "kind", "text", "risk", "criteria"],
  nonGoal: ["id", "kind", "text"],
  branch: ["id", "kind", "question", "leaning"],
  decision: ["id", "kind", "question", "answer", "why", "source", "evidence", "isConstraint"],
  openQuestion: ["id", "kind", "question", "settledBy"],
  unit: ["id", "kind", "title", "reads", "changes", "checks", "serves", "budgetWaiver"],
  design: ["id", "kind", "layer", "title", "code", "at"],
} satisfies Record<Node["kind"], string[]>;
const NODE_ID_PATTERNS = {
  goal: /^G1$/,
  nonGoal: /^N[1-9]\d*$/,
  branch: /^B[1-9]\d*$/,
  decision: /^D[1-9]\d*$/,
  openQuestion: /^Q[1-9]\d*$/,
  unit: /^U[1-9]\d*$/,
  design: /^I[1-9]\d*$/,
};
const EDGE_ENDPOINT_KINDS = {
  blocks: ["branch", ["branch"]],
  implements: ["unit", ["decision", "design"]],
  dependsOn: ["unit", ["unit"]],
  deferredBy: ["unit", ["openQuestion"]],
} satisfies Record<EdgeKind, [Node["kind"], Node["kind"][]]>;
const CHALLENGE_STAMP_PATTERN = /^CHALLENGE: \d+ kept, \d+ shrunk, \d+ cut\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(errors: string[], rule: number, subject: string, fix: string): void {
  errors.push(`Rule ${rule}: ${subject}: ${fix}`.replace(/[\r\n]+/g, " "));
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: string[], subject: string, errors: string[]): void {
  for (const field of Object.keys(value)) {
    if (allowedFields.includes(field)) continue;
    addError(errors, 1, subject, `remove unknown field ${field}`);
  }
}

function requireString(value: unknown, subject: string, errors: string[]): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  addError(errors, 1, subject, "supply a non-empty string");
}

function validateNodeShape(value: unknown, index: number, errors: string[]): void {
  const subject = isRecord(value) && typeof value.id === "string" ? `node ${value.id}` : `node[${index}]`;
  if (!isRecord(value)) {
    addError(errors, 1, subject, "supply a node object");
    return;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(NODE_FIELDS, kind)) {
    addError(errors, 1, subject, "set kind to goal, nonGoal, branch, decision, openQuestion, unit, or design");
    return;
  }
  const nodeKind = kind as Node["kind"];
  rejectUnknownFields(value, NODE_FIELDS[nodeKind], subject, errors);
  if (typeof value.id !== "string" || !NODE_ID_PATTERNS[nodeKind].test(value.id)) {
    addError(errors, 2, subject, `use ${nodeKind === "goal" ? "G1" : `${NODE_ID_PATTERNS[nodeKind].source[1]}<positive integer>`} for a ${nodeKind} id`);
  }
  for (const field of NODE_FIELDS[nodeKind]) {
    if (["id", "kind", "reads", "changes", "checks", "serves", "evidence", "isConstraint", "budgetWaiver", "risk", "criteria", "layer", "at"].includes(field)) continue;
    requireString(value[field], `${subject}.${field}`, errors);
  }
  if (nodeKind === "goal") {
    if (Object.hasOwn(value, "risk") && !["low", "medium", "high", "critical"].includes(value.risk as string)) {
      addError(errors, 1, `${subject}.risk`, "set risk to low, medium, high, or critical, or omit it");
    }
    if (!Object.hasOwn(value, "criteria")) return;
    if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 12) {
      addError(errors, 1, `${subject}.criteria`, "supply an array of 1 to 12 non-empty strings or omit it");
      return;
    }
    value.criteria.forEach((criterion: unknown, criterionIndex: number) => requireString(criterion, `${subject}.criteria[${criterionIndex}]`, errors));
    return;
  }
  if (nodeKind === "decision") {
    if (!["decided", "read", "assumed"].includes(String(value.source))) {
      addError(errors, 1, subject, "set source to decided, read, or assumed");
    }
    if (Object.hasOwn(value, "isConstraint") && typeof value.isConstraint !== "boolean") {
      addError(errors, 1, subject, "set isConstraint to a boolean or omit it");
    }
    if (value.source === "read") {
      if (typeof value.evidence !== "string" || !/^\S(?:.*\S)?:[1-9]\d*$/.test(value.evidence)) {
        addError(errors, 1, subject, "supply evidence as file:line for a read decision");
      }
      return;
    }
    if (Object.hasOwn(value, "evidence")) addError(errors, 1, subject, "omit evidence unless source is read");
    return;
  }
  if (nodeKind === "design") {
    if (!["behavior", "architecture", "program"].includes(value.layer as string)) {
      addError(errors, 1, `${subject}.layer`, "set layer to behavior, architecture, or program");
    }
    if (Object.hasOwn(value, "at")) requireString(value.at, `${subject}.at`, errors);
    if (value.layer === "program" && !Object.hasOwn(value, "at")) addError(errors, 1, `${subject}.at`, "supply at, the path a program design lands in");
    return;
  }
  if (nodeKind !== "unit") return;
  if (typeof value.title === "string" && value.title.length > UNIT_TITLE_LIMIT) {
    addError(errors, 1, `${subject}.title`, `shorten the title to ${UNIT_TITLE_LIMIT} characters (has ${value.title.length}); a challenge bound belongs in the hand off`);
  }
  for (const field of ["reads", "changes"] as const) {
    const paths = value[field];
    if (!Array.isArray(paths)) {
      addError(errors, 1, subject, `supply ${field} as an array of paths`);
      continue;
    }
    paths.forEach((entry: unknown, pathIndex: number) => requireString(entry, `${subject}.${field}[${pathIndex}]`, errors));
  }
  if (Object.hasOwn(value, "budgetWaiver")) requireString(value.budgetWaiver, `${subject}.budgetWaiver`, errors);
  if (Object.hasOwn(value, "serves") && (!Array.isArray(value.serves) || !value.serves.every((criterionNumber: unknown) => Number.isInteger(criterionNumber) && Number(criterionNumber) >= 1))) {
    addError(errors, 1, `${subject}.serves`, "supply serves as an array of goal criterion numbers starting at 1, or omit it");
  }
  if (!Array.isArray(value.checks)) {
    addError(errors, 1, subject, "supply checks as an array of { run: string } objects");
    return;
  }
  value.checks.forEach((check: unknown, checkIndex: number) => {
    const checkSubject = `${subject}.checks[${checkIndex}]`;
    if (!isRecord(check)) {
      addError(errors, 1, checkSubject, "supply a { run: string } object");
      return;
    }
    rejectUnknownFields(check, ["run"], checkSubject, errors);
    requireString(check.run, `${checkSubject}.run`, errors);
  });
}

function validateShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    addError(errors, 1, "spec", "supply a DesignSpec object");
    return errors;
  }
  rejectUnknownFields(value, ["status", "request", "repoRoot", "nodes", "edges", "challengeStamp", "challengedUnitIds"], "spec", errors);
  if (typeof value.status !== "string" || !["sketch", "grilled", "sliced", "challenged"].includes(value.status)) {
    addError(errors, 1, "spec.status", "use sketch, grilled, sliced, or challenged");
  }
  requireString(value.request, "spec.request", errors);
  requireString(value.repoRoot, "spec.repoRoot", errors);
  if (Object.hasOwn(value, "challengeStamp")) requireString(value.challengeStamp, "spec.challengeStamp", errors);
  if (Object.hasOwn(value, "challengedUnitIds") && !Array.isArray(value.challengedUnitIds)) addError(errors, 1, "spec.challengedUnitIds", "supply an array of unit ids");
  if (Array.isArray(value.challengedUnitIds)) {
    value.challengedUnitIds.forEach((unitId: unknown, index: number) => requireString(unitId, `spec.challengedUnitIds[${index}]`, errors));
  }
  if (!Array.isArray(value.nodes)) addError(errors, 1, "spec.nodes", "supply an array of nodes");
  if (Array.isArray(value.nodes)) value.nodes.forEach((node: unknown, index: number) => validateNodeShape(node, index, errors));
  if (!Array.isArray(value.edges)) addError(errors, 1, "spec.edges", "supply an array of edges");
  if (!Array.isArray(value.edges)) return errors;
  value.edges.forEach((edge: unknown, index: number) => {
    const subject = `edge[${index}]`;
    if (!isRecord(edge)) {
      addError(errors, 1, subject, "supply an edge object");
      return;
    }
    rejectUnknownFields(edge, ["from", "kind", "to"], subject, errors);
    requireString(edge.from, `${subject}.from`, errors);
    requireString(edge.to, `${subject}.to`, errors);
    if (typeof edge.kind !== "string" || !Object.hasOwn(EDGE_ENDPOINT_KINDS, edge.kind)) {
      addError(errors, 1, subject, "set kind to blocks, implements, dependsOn, or deferredBy");
    }
  });
  return errors;
}

function edgeSubject(edge: Edge): string {
  return `edge ${edge.from} ${edge.kind} ${edge.to}`;
}

function validateAcyclic(edges: Edge[], kind: "dependsOn" | "blocks", errors: string[]): void {
  const edgesByFrom = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const outgoingEdges = edgesByFrom.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    edgesByFrom.set(edge.from, outgoingEdges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of edgesByFrom.get(id) ?? []) {
      if (visiting.has(edge.to)) {
        addError(errors, 4, edgeSubject(edge), `remove or redirect this edge to break the ${kind} cycle`);
        continue;
      }
      visit(edge.to);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of edgesByFrom.keys()) visit(id);
}

function staysInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isRelativeRepoPath(repoRoot: string, candidate: string): boolean {
  if (candidate !== candidate.trim()) return false;
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false;
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  return staysInside(repoRoot, path.resolve(repoRoot, normalizedCandidate));
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && ["ENOENT", "ENOTDIR"].includes(String(error.code));
}

function failureCodeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return String(error);
}

function resolveExistingPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parentPath = path.dirname(target);
    if (parentPath === target) return target;
    return path.join(resolveExistingPath(parentPath), path.basename(target));
  }
}

function resolveExistingDirectory(target: string): string | undefined {
  try {
    const resolvedTarget = fs.realpathSync(target);
    return fs.statSync(resolvedTarget).isDirectory() ? resolvedTarget : undefined;
  } catch {
    return undefined;
  }
}

function listedPathProblem(repoRoot: string, resolvedRoot: string | undefined, candidate: string, isRead: boolean, pathsOtherUnitsChange: string[]): string | undefined {
  if (!isRelativeRepoPath(repoRoot, candidate)) return `replace path ${candidate} with a relative path inside repoRoot`;
  if (resolvedRoot === undefined) return undefined;
  const listedPath = path.resolve(repoRoot, candidate);
  let resolvedPath: string;
  try {
    resolvedPath = resolveExistingPath(listedPath);
  } catch (error) {
    return `path ${candidate} cannot be resolved (${failureCodeOf(error)}); replace it with a readable path inside the repo`;
  }
  if (!staysInside(resolvedRoot, resolvedPath)) return `path ${candidate} resolves outside repoRoot; replace it with a path inside the repo`;
  if (!isRead || fs.existsSync(resolvedPath)) return undefined;
  if (pathsOtherUnitsChange.some((changedPath) => staysInside(changedPath, listedPath))) return undefined;
  return `reads path ${candidate} is missing under repoRoot; correct it, or list it under the changes of another unit that creates it`;
}

export function listPathWithAncestors(targetPath: string): string[] {
  const parentPath = path.dirname(targetPath);
  if (parentPath === targetPath) return [targetPath];
  return [targetPath, ...listPathWithAncestors(parentPath)];
}

function unitPairKey(unitId: string, otherUnitId: string): string {
  return JSON.stringify([unitId, otherUnitId].sort());
}

function findSharedRepoPathsByUnitPair(rootPath: string, changedPathsById: Map<string, string[]>): Map<string, string> {
  const unitIdsByChangedPath = new Map<string, Set<string>>();
  for (const [unitId, changedPaths] of changedPathsById) {
    for (const changedPath of changedPaths) {
      const unitIds = unitIdsByChangedPath.get(changedPath) ?? new Set<string>();
      unitIds.add(unitId);
      unitIdsByChangedPath.set(changedPath, unitIds);
    }
  }
  const sharedRepoPathsByUnitPair = new Map<string, string>();
  for (const [unitId, changedPaths] of changedPathsById) {
    for (const changedPath of changedPaths) {
      for (const containingPath of listPathWithAncestors(changedPath)) {
        for (const otherUnitId of unitIdsByChangedPath.get(containingPath) ?? []) {
          const unitPair = unitPairKey(unitId, otherUnitId);
          if (otherUnitId === unitId || sharedRepoPathsByUnitPair.has(unitPair)) continue;
          sharedRepoPathsByUnitPair.set(unitPair, path.relative(rootPath, changedPath) || ".");
        }
      }
    }
  }
  return sharedRepoPathsByUnitPair;
}

type ReadingMeasurement = { totalBytes: number; unmeasurablePaths: string[] };

function measureReadingBytes(resolvedRoot: string, listedPaths: string[]): ReadingMeasurement {
  const visitedPaths = new Set<string>();
  const unmeasurablePaths: string[] = [];
  function measure(target: string): number {
    try {
      const resolvedTarget = fs.realpathSync(target);
      if (!staysInside(resolvedRoot, resolvedTarget) || visitedPaths.has(resolvedTarget)) return 0;
      visitedPaths.add(resolvedTarget);
      const fileStatus = fs.statSync(resolvedTarget);
      if (fileStatus.isFile()) return fileStatus.size;
      if (!fileStatus.isDirectory()) return 0;
      return fs.readdirSync(resolvedTarget)
        .filter((entry: string) => entry !== ".git" && entry !== "node_modules")
        .reduce((totalBytes: number, entry: string) => totalBytes + measure(path.join(resolvedTarget, entry)), 0);
    } catch (error) {
      if (!isMissingPathError(error)) unmeasurablePaths.push(`${target} (${failureCodeOf(error)})`);
      return 0;
    }
  }
  const totalBytes = [...new Set(listedPaths)].reduce((runningBytes, listedPath) => runningBytes + measure(listedPath), 0);
  return { totalBytes, unmeasurablePaths };
}

function validateChallengeStamp(spec: DesignSpec, units: Unit[], errors: string[]): void {
  if (spec.status !== "challenged") {
    if (spec.challengeStamp !== undefined) addError(errors, 7, "spec.challengeStamp", "omit challengeStamp until status is challenged");
    if (spec.challengedUnitIds !== undefined) addError(errors, 7, "spec.challengedUnitIds", "omit challengedUnitIds until status is challenged");
    return;
  }
  if (!spec.challengeStamp || !CHALLENGE_STAMP_PATTERN.test(spec.challengeStamp)) {
    addError(errors, 7, "spec.challengeStamp", "supply CHALLENGE: <n> kept, <n> shrunk, <n> cut for challenged status");
  }
  if (spec.challengedUnitIds === undefined) {
    addError(errors, 7, "spec.challengedUnitIds", "supply the ids of the units without a deferredBy edge that the challenge judged");
    return;
  }
  const deferredUnitIds = new Set<string>(spec.edges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.from));
  const readyUnitIds: string[] = units.filter((unit) => !deferredUnitIds.has(unit.id)).map((unit) => unit.id);
  const challengedUnitIds = new Set(spec.challengedUnitIds);
  if (spec.challengedUnitIds.length === readyUnitIds.length && readyUnitIds.every((unitId) => challengedUnitIds.has(unitId))) return;
  addError(
    errors,
    7,
    "spec.challengedUnitIds",
    `the challenge judged ${spec.challengedUnitIds.join(", ") || "zero units"} while the units without a deferredBy edge are ${readyUnitIds.join(", ") || "none"}; set status back to sketch, grilled, or sliced and remove challengeStamp and challengedUnitIds before changing units`,
  );
}

export function validateGraph(value: unknown): string[] {
  const errors = validateShape(value);
  if (errors.length > 0) return errors;
  const spec = value as DesignSpec;
  const nodesById = new Map<string, Node>();
  for (const node of spec.nodes) {
    if (nodesById.has(node.id)) addError(errors, 2, `node ${node.id}`, "give each node a unique id");
    nodesById.set(node.id, node);
  }
  if (spec.nodes.filter((node) => node.kind === "goal").length !== 1) addError(errors, 2, "node G1", "include exactly one goal node");
  const seenEdges = new Set<string>();
  for (const edge of spec.edges) {
    const subject = edgeSubject(edge);
    const edgeKey = JSON.stringify([edge.from, edge.kind, edge.to]);
    if (seenEdges.has(edgeKey)) addError(errors, 3, subject, "remove the duplicate edge");
    seenEdges.add(edgeKey);
    if (edge.from === edge.to) addError(errors, 3, subject, "remove the self edge");
    const [fromKind, toKinds] = EDGE_ENDPOINT_KINDS[edge.kind];
    if (nodesById.get(edge.from)?.kind !== fromKind) addError(errors, 3, subject, `set from to an existing ${fromKind} node`);
    if (!(toKinds as Node["kind"][]).includes(nodesById.get(edge.to)?.kind as Node["kind"])) addError(errors, 3, subject, `set to to an existing ${toKinds.join(" or ")} node`);
  }
  validateAcyclic(spec.edges, "dependsOn", errors);
  validateAcyclic(spec.edges, "blocks", errors);
  const deferredIds = new Set<string>(spec.edges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.from));
  const dependentsById = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (edge.kind !== "dependsOn") continue;
    const dependents = dependentsById.get(edge.to) ?? [];
    dependents.push(edge.from);
    dependentsById.set(edge.to, dependents);
  }
  const pendingDeferredIds: string[] = [...deferredIds];
  for (let index = 0; index < pendingDeferredIds.length; index++) {
    for (const dependentId of dependentsById.get(pendingDeferredIds[index] ?? "") ?? []) {
      if (deferredIds.has(dependentId)) continue;
      deferredIds.add(dependentId);
      pendingDeferredIds.push(dependentId);
      addError(errors, 5, `node ${dependentId}`, "add a deferredBy edge because its dependency is deferred");
    }
  }
  const resolvedRoot = path.isAbsolute(spec.repoRoot) ? resolveExistingDirectory(spec.repoRoot) : undefined;
  if (resolvedRoot === undefined) addError(errors, 6, "spec.repoRoot", "supply the absolute path of an existing repository directory");
  const units = spec.nodes.filter((node): node is Unit => node.kind === "unit");
  for (const unit of units) {
    const pathsOtherUnitsChange = units
      .filter((otherUnit) => otherUnit.id !== unit.id)
      .flatMap((otherUnit) => otherUnit.changes.map((changedPath) => path.resolve(spec.repoRoot, changedPath)));
    for (const field of ["reads", "changes"] as const) {
      for (const candidate of unit[field]) {
        const problem = listedPathProblem(spec.repoRoot, resolvedRoot, candidate, field === "reads", pathsOtherUnitsChange);
        if (problem !== undefined) addError(errors, 6, `node ${unit.id}`, problem);
      }
    }
  }
  validateChallengeStamp(spec, units, errors);
  if (spec.status !== "sketch") {
    for (const node of spec.nodes) {
      if (node.kind === "branch") addError(errors, 8, `node ${node.id}`, "settle and remove this branch before grilled, sliced, or challenged status");
    }
  }
  const isSliced = spec.status === "sliced" || spec.status === "challenged";
  if (isSliced && units.length === 0) addError(errors, 9, "spec.nodes", "add at least one unit for sliced or challenged status");
  const implementedIds = new Set(spec.edges.filter((edge) => edge.kind === "implements").map((edge) => edge.to));
  const implementingIds = new Set(spec.edges.filter((edge) => edge.kind === "implements").map((edge) => edge.from));
  const goal = spec.nodes.find((node): node is Goal => node.kind === "goal");
  const goalCriteria = goal?.criteria ?? [];
  const isGoalMissingCriteria = isSliced && goal !== undefined && goalCriteria.length === 0;
  if (isGoalMissingCriteria) addError(errors, 17, "node G1", "add criteria, 1 to 12 observable results; every unit serves one at sliced status");
  for (const unit of units) {
    if (!isSliced) continue;
    if (unit.changes.length === 0) addError(errors, 10, `node ${unit.id}`, "add at least one changes path");
    if (unit.checks.length === 0) addError(errors, 10, `node ${unit.id}`, "add at least one check with a run command");
    for (const [checkIndex, check] of unit.checks.entries()) {
      const normalizedCommand = check.run.replace(/[\t\r\n]/g, " ");
      if (/[;&|<>$`'"\x00-\x1f\x7f-\x9f]/.test(normalizedCommand)) {
        addError(errors, 14, `node ${unit.id}.checks[${checkIndex}].run`, "supply one command without shell operators, quotes, or control characters");
      }
    }
    for (const changedPath of unit.changes) {
      if (!/[*?\[\]]/.test(changedPath)) continue;
      addError(errors, 15, `node ${unit.id}`, `replace changes path ${changedPath} with a literal path without wildcards`);
    }
    if (!implementingIds.has(unit.id)) addError(errors, 11, `node ${unit.id}`, "add an implements edge to a decision");
    if (!isGoalMissingCriteria && (unit.serves ?? []).length === 0) addError(errors, 17, `node ${unit.id}`, "add serves naming the goal criteria this unit makes true; a unit serving none is a horizontal layer, so fold it into the vertical slice that needs it");
  }
  const servedCriterionNumbers = new Set(units.flatMap((unit) => unit.serves ?? []));
  for (const unit of units) {
    for (const criterionNumber of unit.serves ?? []) {
      if (isGoalMissingCriteria || criterionNumber <= goalCriteria.length) continue;
      addError(errors, 17, `node ${unit.id}`, `remove serves ${criterionNumber}; the goal has ${goalCriteria.length} criteria`);
    }
  }
  for (const [criterionIndex, criterion] of goalCriteria.entries()) {
    if (!isSliced || servedCriterionNumbers.has(criterionIndex + 1)) continue;
    addError(errors, 17, "node G1", `add ${criterionIndex + 1} to the serves of each unit that makes criterion ${criterionIndex + 1} true: ${criterion}`);
  }
  for (const node of spec.nodes) {
    if (!isSliced) continue;
    if (node.kind === "design" && !implementedIds.has(node.id)) addError(errors, 12, `node ${node.id}`, "add an implements edge from the unit that builds this design");
    if (node.kind !== "decision" || node.isConstraint === true || implementedIds.has(node.id)) continue;
    addError(errors, 12, `node ${node.id}`, "add an implements edge from a unit or mark the decision isConstraint: true");
  }
  const goalRisk = goal?.risk;
  const needsDesign = goalRisk !== "low";
  if (isSliced && needsDesign && !spec.nodes.some((node) => node.kind === "design")) {
    addError(errors, 18, "spec.nodes", `add design nodes from subskills/design.md; a spec settles its design before slicing unless its risk is low (risk is ${goalRisk ?? "unset"})`);
  }
  if (resolvedRoot === undefined || errors.some((error) => error.startsWith("Rule 6:"))) return errors;
  if (isSliced) {
    const resolvedChangedPathsById = new Map(units.map((unit) => [unit.id, unit.changes.map((candidate) => resolveExistingPath(path.resolve(spec.repoRoot, candidate)))]));
    const lexicalChangedPathsById = new Map(units.map((unit) => [unit.id, unit.changes.map((candidate) => path.resolve(spec.repoRoot, candidate.trim().replace(/\\/g, "/")))]));
    const reachableDependentsById = new Map<string, Set<string>>();
    for (const unit of units) {
      const reachableDependents = new Set<string>();
      const pendingIds: string[] = [unit.id];
      for (let index = 0; index < pendingIds.length; index++) {
        for (const dependentId of dependentsById.get(pendingIds[index]) ?? []) {
          if (reachableDependents.has(dependentId)) continue;
          reachableDependents.add(dependentId);
          pendingIds.push(dependentId);
        }
      }
      reachableDependentsById.set(unit.id, reachableDependents);
    }
    const resolvedSharedRepoPathsByUnitPair = findSharedRepoPathsByUnitPair(resolvedRoot, resolvedChangedPathsById);
    const lexicalSharedRepoPathsByUnitPair = findSharedRepoPathsByUnitPair(spec.repoRoot, lexicalChangedPathsById);
    for (const [unitIndex, unit] of units.entries()) {
      for (const otherUnit of units.slice(unitIndex + 1)) {
        if (reachableDependentsById.get(unit.id)?.has(otherUnit.id) || reachableDependentsById.get(otherUnit.id)?.has(unit.id)) continue;
        const unitPair = unitPairKey(unit.id, otherUnit.id);
        const sharedRepoPath = resolvedSharedRepoPathsByUnitPair.get(unitPair) ?? lexicalSharedRepoPathsByUnitPair.get(unitPair);
        if (sharedRepoPath === undefined) continue;
        addError(errors, 16, `node ${unit.id}`, `add a direct or transitive dependsOn path in either direction with ${otherUnit.id} to order changes sharing ${sharedRepoPath}`);
      }
    }
  }
  for (const unit of units) {
    if (!isSliced || unit.budgetWaiver !== undefined) continue;
    const listedPaths = [...unit.reads, ...unit.changes].map((candidate) => path.resolve(spec.repoRoot, candidate));
    const { totalBytes, unmeasurablePaths } = measureReadingBytes(resolvedRoot, listedPaths);
    for (const unmeasurablePath of unmeasurablePaths) {
      addError(errors, 13, `node ${unit.id}`, `path ${unmeasurablePath} cannot be measured; narrow reads and changes to readable paths or supply budgetWaiver`);
    }
    if (totalBytes <= READING_BUDGET_BYTES) continue;
    addError(errors, 13, `node ${unit.id}`, `reads and changes total ${totalBytes} bytes above ${READING_BUDGET_BYTES} bytes; narrow the paths or supply budgetWaiver`);
  }
  return errors;
}
