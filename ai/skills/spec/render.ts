import type { DesignSpec } from "./lib/graph.ts";
import { readSpec } from "./lib/read-spec.ts";
import { unitsInDependencyOrder } from "./lib/unit-order.ts";

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function render(spec: DesignSpec, mode: string): string {
  if (mode === "goal") {
    return spec.nodes.flatMap((node) => {
      if (node.kind === "goal") return [`Goal: ${node.text}`];
      return [];
    }).concat(
      spec.nodes.flatMap((node) => node.kind === "nonGoal" ? [`Non-goal: ${node.text}`] : []),
      spec.nodes.flatMap((node) => node.kind === "decision" ? [`${node.id}: ${node.question} -> ${node.answer} (${node.source})`] : []),
    ).map(oneLine).join("\n");
  }
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];
  let stepNumber = 0;
  for (const unit of unitsInDependencyOrder(spec)) {
    const outgoingEdges = spec.edges.filter((edge) => edge.from === unit.id);
    const implementedIds = outgoingEdges.filter((edge) => edge.kind === "implements").map((edge) => edge.to);
    const dependencyIds = outgoingEdges.filter((edge) => edge.kind === "dependsOn").map((edge) => edge.to);
    const deferredIds = outgoingEdges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.to);
    if (mode === "plan") {
      if (deferredIds.length > 0) continue;
      stepNumber++;
      lines.push(`${stepNumber}. ${unit.id} ${oneLine(unit.title)}`);
      lines.push(`   - implements: ${implementedIds.join(", ")}`);
      lines.push(`   - reads: ${unit.reads.map(oneLine).join(", ")}`);
      lines.push(`   - changes: ${unit.changes.map(oneLine).join(", ")}`);
      lines.push(`   - checks: ${unit.checks.map((check) => `\`${oneLine(check.run)}\``).join("; ")}`);
      if (dependencyIds.length > 0) lines.push(`   - depends on: ${dependencyIds.join(", ")}`);
      continue;
    }
    lines.push(`${unit.id} ${oneLine(unit.title)}`);
    if (dependencyIds.length > 0) lines.push(`  depends on ${dependencyIds.join(" ")}`);
    lines.push(`  implements ${implementedIds.join(" ")}`);
    for (const questionId of deferredIds) {
      const question = nodesById.get(questionId);
      if (question?.kind === "openQuestion") lines.push(`  deferred by ${questionId} (${oneLine(question.question)})`);
    }
    if (unit.budgetWaiver) lines.push(`  budget waiver (${oneLine(unit.budgetWaiver)})`);
  }
  return lines.join("\n");
}

const { report, spec } = readSpec(process.argv[2]);
if (!spec) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(1);
}
const mode = process.argv[3];
if (mode !== "tree" && mode !== "plan" && mode !== "goal") {
  process.stdout.write(`${JSON.stringify({ outcome: "INVALID", errors: ["Rule 1: render mode: supply tree, plan, or goal"] })}\n`);
  process.exit(1);
}
process.stdout.write(`${render(spec, mode)}\n`);
