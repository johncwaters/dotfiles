import fs from "node:fs";
import path from "node:path";
import type { DesignSpec } from "./lib/graph.ts";
import { readSpec } from "./lib/read-spec.ts";
import { unitsInDependencyOrder } from "./lib/unit-order.ts";

function oneLine(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

const intentWriteScopeLimit = 32;

function normalizeScope(scope: string): string {
  return scope.trim().replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

function containsScope(parentScope: string, childScope: string): boolean {
  return parentScope === childScope || childScope.startsWith(`${parentScope}/`);
}

function removeContainedScopes(scopes: string[]): string[] {
  return [...new Set(scopes)].filter((scope, index, distinctScopes) =>
    !distinctScopes.some((otherScope, otherIndex) => otherIndex !== index && containsScope(otherScope, scope)));
}

function findMostSharedParentScope(scopes: string[]): string | undefined {
  const parentScopes = [...new Set(scopes.map((scope) => path.posix.dirname(scope)))].filter((parentScope) => parentScope !== ".");
  const sharedParents = parentScopes
    .map((parentScope) => ({ parentScope, containedCount: scopes.filter((scope) => containsScope(parentScope, scope)).length }))
    .filter((sharedParent) => sharedParent.containedCount >= 2);
  sharedParents.sort((first, second) =>
    second.containedCount - first.containedCount
    || second.parentScope.split("/").length - first.parentScope.split("/").length
    || (first.parentScope < second.parentScope ? -1 : 1));
  return sharedParents[0]?.parentScope;
}

function foldIntentScopes(ticketScopes: string[]): string[] {
  let scopes = removeContainedScopes(ticketScopes);
  while (scopes.length > intentWriteScopeLimit) {
    const sharedParentScope = findMostSharedParentScope(scopes);
    if (sharedParentScope === undefined) return scopes;
    scopes = [...new Set(scopes.map((scope) => containsScope(sharedParentScope, scope) ? sharedParentScope : scope))];
  }
  return scopes;
}

function renderIntent(spec: DesignSpec, specPath: string) {
  const goal = spec.nodes.find((node) => node.kind === "goal")!;
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const nonGoals = spec.nodes.flatMap((node) => node.kind === "nonGoal" ? [node.text] : []);
  const constraints = spec.nodes.flatMap((node) => node.kind === "decision" && node.isConstraint === true ? [node.answer] : []);
  const edgesByFrom = new Map<string, DesignSpec["edges"]>();
  for (const edge of spec.edges) {
    const outgoingEdges = edgesByFrom.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    edgesByFrom.set(edge.from, outgoingEdges);
  }
  const tickets = unitsInDependencyOrder(spec).map((unit) => {
    const outgoingEdges = edgesByFrom.get(unit.id) ?? [];
    const decisions = outgoingEdges.flatMap((edge) => {
      if (edge.kind !== "implements") return [];
      const decision = nodesById.get(edge.to);
      if (decision?.kind !== "decision" || decision.isConstraint === true) return [];
      return [decision.answer];
    });
    const title = oneLine(unit.title);
    const objective = `${title}${title.endsWith(".") ? "" : "."}`
      + (decisions.length > 0 ? ` Decisions: ${decisions.join(" ")}` : "")
      + (unit.reads.length > 0 ? ` Read first: ${unit.reads.join(", ")}` : "");
    return {
      id: unit.id,
      objective: oneLine(objective),
      criteria: [...new Set([title, ...unit.checks.map((check) => oneLine(`The command ${check.run} exits 0.`))])],
      dependsOn: outgoingEdges.filter((edge) => edge.kind === "dependsOn").map((edge) => edge.to),
      writeScopes: [...new Set(unit.changes.map(normalizeScope))],
    };
  });
  const boundary = `Repository ${path.basename(path.dirname(specPath))}.`
    + (nonGoals.length > 0 ? ` Non-goals: ${nonGoals.join(" ")}` : "")
    + (constraints.length > 0 ? ` Constraints: ${constraints.join(" ")}` : "");
  return {
    name: oneLine(path.basename(specPath, ".json")),
    projectId: "seed",
    objective: oneLine(goal.text),
    criteria: (goal.criteria ?? []).map(oneLine),
    risk: goal.risk ?? "",
    boundary: oneLine(boundary),
    writeScopes: foldIntentScopes(tickets.flatMap((ticket) => ticket.writeScopes)),
    tickets,
  };
}

function collectTextErrors(value: unknown, subject: string, errors: string[]): void {
  if (typeof value === "string") {
    if (value.length > 4096) errors.push(`${subject}: shorten text to the 4096 character limit (has ${value.length})`);
    if (value.startsWith("-")) errors.push(`${subject}: replace the leading '-' in rendered text`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTextErrors(entry, `${subject}[${index}]`, errors));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [field, entry] of Object.entries(value)) collectTextErrors(entry, `${subject}.${field}`, errors);
}

function collectScopeErrors(scopes: string[], subject: string, errors: string[]): void {
  for (const scope of scopes) {
    if (scope.length <= 1024) continue;
    errors.push(`${subject}: shorten write scope ${scope} to the 1024 character limit (has ${scope.length})`);
  }
}

function collectRefusalErrors(spec: DesignSpec, intent: ReturnType<typeof renderIntent>): string[] {
  const errors: string[] = [];
  if (spec.status !== "challenged") errors.push(`intent: change status from ${spec.status} to challenged`);
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  for (const edge of spec.edges) {
    if (edge.kind !== "deferredBy") continue;
    const question = nodesById.get(edge.to);
    if (question?.kind === "openQuestion") errors.push(`${edge.from}: settle open question ${question.id}: ${oneLine(question.question)} and remove its deferredBy edge`);
  }
  const goal = spec.nodes.find((node) => node.kind === "goal")!;
  if (goal.risk === undefined) errors.push("intent: supply goal G1.risk");
  if (goal.criteria === undefined) errors.push("intent: supply goal G1.criteria");
  if (intent.tickets.length > 32) errors.push(`intent: reduce tickets to the 32 ticket limit (has ${intent.tickets.length})`);
  const { tickets, ...intentFields } = intent;
  collectTextErrors(intentFields, "intent", errors);
  collectScopeErrors(intent.writeScopes, "intent", errors);
  if (intent.writeScopes.length > intentWriteScopeLimit) {
    errors.push(`intent: reduce write scopes to the ${intentWriteScopeLimit} write scope limit (has ${intent.writeScopes.length} with no shared parent folder left to fold into)`);
  }
  for (const ticket of tickets) {
    if (ticket.id.length > 64) errors.push(`${ticket.id}: shorten ticket id to the 64 character limit (has ${ticket.id.length})`);
    if (ticket.criteria.length > 12) errors.push(`${ticket.id}: reduce criteria to the 12 criterion limit (has ${ticket.criteria.length})`);
    if (ticket.writeScopes.length > 32) errors.push(`${ticket.id}: reduce write scopes to the 32 scope limit (has ${ticket.writeScopes.length})`);
    collectTextErrors(ticket, ticket.id, errors);
    collectScopeErrors(ticket.writeScopes, ticket.id, errors);
  }
  for (const node of spec.nodes) {
    if (node.kind !== "unit") continue;
    for (const changedPath of node.changes) {
      const trimmedPath = changedPath.trim();
      const scope = normalizeScope(changedPath);
      if (trimmedPath !== oneLine(changedPath)) errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with the exact path, free of whitespace runs and of whitespace other than a single plain space`);
      if (scope === "") errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with one that names a file or folder below the repository root`);
      const isAbsolutePath = trimmedPath.replace(/\\/g, "/").startsWith("/");
      if (!scope.split("/").includes("..") && !/^-|^[a-z]:/i.test(scope) && !isAbsolutePath && !/[\x00-\x1f\x7f-\x9f]/.test(changedPath)) continue;
      errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with a relative write scope without '..' segments, a leading '-', '/', drive letter, or control characters`);
    }
  }
  return errors.map(oneLine);
}

function resolveIntentPath(specPath: string): string {
  return path.join(path.dirname(specPath), `${path.basename(specPath, ".json")}.intent.json`);
}

function removeStaleIntent(specArgument: string | undefined): void {
  if (!specArgument) return;
  fs.rmSync(resolveIntentPath(path.resolve(specArgument)), { force: true });
}

function cutSpec(specArgument: string | undefined): number {
  const { report, spec } = readSpec(specArgument);
  if (!specArgument || !spec) {
    removeStaleIntent(specArgument);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 1;
  }
  const specPath = path.resolve(specArgument);
  const intentPath = resolveIntentPath(specPath);
  const intent = renderIntent(spec, specPath);
  const errors = collectRefusalErrors(spec, intent);
  if (errors.length > 0) {
    fs.rmSync(intentPath, { force: true });
    process.stdout.write(`${JSON.stringify({ outcome: "REFUSED", errors })}\n`);
    return 1;
  }
  fs.writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outcome: "CUT", intentPath, tickets: intent.tickets.length })}\n`);
  return 0;
}

process.exitCode = cutSpec(process.argv[2]);
