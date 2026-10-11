import fs from "node:fs";
import path from "node:path";

export type Goal = { id: "G1"; kind: "goal"; text: string };
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
  budgetWaiver?: string;
};
export type Node = Goal | NonGoal | Branch | Decision | OpenQuestion | Unit;
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

const NODE_FIELDS = {
  goal: ["id", "kind", "text"],
  nonGoal: ["id", "kind", "text"],
  branch: ["id", "kind", "question", "leaning"],
  decision: ["id", "kind", "question", "answer", "why", "source", "evidence", "isConstraint"],
  openQuestion: ["id", "kind", "question", "settledBy"],
  unit: ["id", "kind", "title", "reads", "changes", "checks", "budgetWaiver"],
} satisfies Record<Node["kind"], string[]>;
const NODE_ID_PATTERNS = {
  goal: /^G1$/,
  nonGoal: /^N[1-9]\d*$/,
  branch: /^B[1-9]\d*$/,
  decision: /^D[1-9]\d*$/,
  openQuestion: /^Q[1-9]\d*$/,
  unit: /^U[1-9]\d*$/,
};
const EDGE_ENDPOINT_KINDS = {
  blocks: ["branch", "branch"],
  implements: ["unit", "decision"],
  dependsOn: ["unit", "unit"],
  deferredBy: ["unit", "openQuestion"],
} satisfies Record<EdgeKind, [Node["kind"], Node["kind"]]>;
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
    addError(errors, 1, subject, "set kind to goal, nonGoal, branch, decision, openQuestion, or unit");
    return;
  }
  const nodeKind = kind as Node["kind"];
  rejectUnknownFields(value, NODE_FIELDS[nodeKind], subject, errors);
  if (typeof value.id !== "string" || !NODE_ID_PATTERNS[nodeKind].test(value.id)) {
    addError(errors, 2, subject, `use ${nodeKind === "goal" ? "G1" : `${NODE_ID_PATTERNS[nodeKind].source[1]}<positive integer>`} for a ${nodeKind} id`);
  }
  for (const field of NODE_FIELDS[nodeKind]) {
    if (["id", "kind", "reads", "changes", "checks", "evidence", "isConstraint", "budgetWaiver"].includes(field)) continue;
    requireString(value[field], `${subject}.${field}`, errors);
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
  if (nodeKind !== "unit") return;
  for (const field of ["reads", "changes"] as const) {
    const paths = value[field];
    if (!Array.isArray(paths)) {
      addError(errors, 1, subject, `supply ${field} as an array of paths`);
      continue;
    }
    paths.forEach((entry: unknown, pathIndex: number) => requireString(entry, `${subject}.${field}[${pathIndex}]`, errors));
  }
  if (Object.hasOwn(value, "budgetWaiver")) requireString(value.budgetWaiver, `${subject}.budgetWaiver`, errors);
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
    const [fromKind, toKind] = EDGE_ENDPOINT_KINDS[edge.kind];
    if (nodesById.get(edge.from)?.kind !== fromKind) addError(errors, 3, subject, `set from to an existing ${fromKind} node`);
    if (nodesById.get(edge.to)?.kind !== toKind) addError(errors, 3, subject, `set to to an existing ${toKind} node`);
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
  for (const unit of units) {
    if (!isSliced) continue;
    if (unit.changes.length === 0) addError(errors, 10, `node ${unit.id}`, "add at least one changes path");
    if (unit.checks.length === 0) addError(errors, 10, `node ${unit.id}`, "add at least one check with a run command");
    if (!implementingIds.has(unit.id)) addError(errors, 11, `node ${unit.id}`, "add an implements edge to a decision");
  }
  for (const node of spec.nodes) {
    if (!isSliced) continue;
    if (node.kind !== "decision" || node.isConstraint === true || implementedIds.has(node.id)) continue;
    addError(errors, 12, `node ${node.id}`, "add an implements edge from a unit or mark the decision isConstraint: true");
  }
  if (resolvedRoot === undefined || errors.some((error) => error.startsWith("Rule 6:"))) return errors;
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
