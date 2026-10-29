import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { compareText, escapeHtml, heading, renderGraphPage, writeGraphPage } from '../../lib/graph-page.mts';
import type { LayoutNode } from '../../lib/graph-page.mts';
import { extractGraph } from './extract.ts';
import type { EdgeKind, GraphNode, SkillGraph } from './extract.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const drawnEdgeKinds: EdgeKind[] = ['loads', 'mentions', 'spawns', 'runs', 'names'];

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}

function describeNode(node: GraphNode): string {
  const parts = [node.kind, formatBytes(node.bytes)];
  if (node.subskills > 0) parts.push(`${node.subskills} sub`);
  if (node.references > 0) parts.push(`${node.references} ref`);
  return parts.join(' · ');
}

function describeStart(node: GraphNode): string {
  if (!node.events?.length) return '▶ start';
  return `▶ on ${[...new Set(node.events.map((registration) => registration.event))].join(', ')}`;
}

function nodeLines(node: GraphNode, isEntry: boolean, extendedBaseName: string | undefined): string[] {
  const lines = [node.name, describeNode(node)];
  if (extendedBaseName) lines.push(`+ extends ${extendedBaseName}`);
  if (isEntry) lines.push(describeStart(node));
  return lines;
}

async function layOutWithElk(input: LayoutNode): Promise<LayoutNode> {
  return await new ELK().layout(input as ElkNode) as LayoutNode;
}

async function render(graph: SkillGraph): Promise<string> {
  const isolatedIds = new Set(graph.isolated);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const drawnEdges = graph.edges.filter((edge) => edge.kind !== 'extends');
  const baseNameByExtensionId = new Map(graph.edges.filter((edge) => edge.kind === 'extends').map((edge) => [edge.to, nodesById.get(edge.from)!.name]));
  const targetIds = new Set(drawnEdges.map((edge) => edge.to));
  const entryIds = new Set(drawnEdges.map((edge) => edge.from).filter((id) => !targetIds.has(id)));
  const cycleByNodeId = new Map(graph.cycles.flatMap((cycle, cycleIndex) => cycle.map((id) => [id, cycleIndex] as const)));
  const profiles = [...new Set(graph.nodes.map((node) => node.profile))].sort(compareText);
  const nodesByProfile = new Map(profiles.map((profile) => [profile, graph.nodes.filter((node) => node.profile === profile)]));
  const isolatedList = graph.isolated.length ? profiles.flatMap((profile) => {
    const isolatedMembers = nodesByProfile.get(profile)!.filter((node) => isolatedIds.has(node.id));
    if (!isolatedMembers.length) return [];
    return [`<p>${escapeHtml(profile)}</p><ul>${isolatedMembers.map((node) => `<li class="signal"><button type="button" class="open-node" data-id="${escapeHtml(node.id)}">${escapeHtml(node.name)}</button> <span class="tag">${escapeHtml(describeNode(node))}</span></li>`).join('')}</ul>`];
  }).join('\n') : '<p>unconnected: none</p>';
  const cycleList = graph.cycles.length ? `<ul>${graph.cycles.map((cycle) => `<li class="signal">load cycles: ${cycle.map(escapeHtml).join(', ')}</li>`).join('')}</ul>` : '<p>cycles: none</p>';
  const edgeRows = graph.edges.map((edge) => `<tr><td>${escapeHtml(edge.from)}</td><td>${edge.kind}</td><td>${escapeHtml(edge.to)}</td></tr>`).join('\n');
  const kinds = ['skill', 'agent', 'workflow', 'hook'] as const;
  const profileRows = profiles.map((profile) => {
    const members = nodesByProfile.get(profile)!;
    return `<tr><th scope="row">${escapeHtml(profile)}</th>${kinds.map((kind) => `<td>${members.filter((node) => node.kind === kind).length}</td>`).join('')}<td>${members.length}</td></tr>`;
  }).join('\n');
  const sectionsHtml = `${heading('signals')}
<p>unconnected: ${graph.isolated.length} / load cycles: ${graph.cycles.length}</p>
${isolatedList}
${cycleList}
${heading('all edges')}
<div class="scroll" tabindex="0" role="region" aria-label="All edges"><table><thead><tr><th scope="col">from</th><th scope="col">kind</th><th scope="col">to</th></tr></thead><tbody>
${edgeRows}
</tbody></table></div>
${heading('profiles')}
<div class="scroll" tabindex="0" role="region" aria-label="Profile counts"><table><thead><tr><th scope="col">profile</th>${kinds.map((kind) => `<th scope="col">${kind}</th>`).join('')}<th scope="col">total</th></tr></thead><tbody>
${profileRows}
</tbody></table></div>`;
  return renderGraphPage({
    title: 'skill tree',
    documentTitle: 'Skill tree',
    fileSlug: 'skill-tree',
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      group: node.profile,
      hoverTitle: `${node.id} / ${node.path}`,
      detailLines: nodeLines(node, entryIds.has(node.id), baseNameByExtensionId.get(node.id)),
      cardLine: `${entryIds.has(node.id) ? '▶ ' : ''}${node.name}`,
      files: node.files,
      isEntry: entryIds.has(node.id),
      isDrawn: !isolatedIds.has(node.id),
    })),
    groups: profiles,
    edges: drawnEdges.map((edge) => {
      const isCycle = cycleByNodeId.has(edge.from) && cycleByNodeId.get(edge.from) === cycleByNodeId.get(edge.to);
      return { from: edge.from, to: edge.to, kind: edge.kind, title: `${edge.from} ${edge.kind} ${edge.to}${isCycle ? ' (cycle)' : ''}`, isSignal: isCycle };
    }),
    edgeKinds: drawnEdgeKinds,
    unmarkedKinds: ['mentions'],
    layout: 'groupBoxes',
    summary: `${graph.nodes.length} nodes, ${graph.edges.length} typed edges, ${profiles.length} profiles, ${graph.isolated.length} unconnected, ${graph.cycles.length} load cycles`,
    caption: 'skill tree / arrows point from the file that names a node to that node; ▶ marks a starting point, a box nothing points into, pinned to the left edge; boxes group profiles; unconnected nodes are listed under signals. Hover a box or edge for its path or kind; click a box to read its files.',
    signalNote: 'signal accent: edges inside a load cycle, and unconnected nodes in the signals list.',
    sectionsHtml,
    filesRoot: repoRoot,
    shareRows: [...kinds.map((kind) => [`${kind}s`, graph.nodes.filter((node) => node.kind === kind).length] as [string, number]), ['starting points', entryIds.size], ['profiles', profiles.length]],
    shareLinksRowIndex: 4,
    shareKeyLines: ['▶ starting point', 'accent: load cycles'],
  }, layOutWithElk);
}

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('Usage: node render.ts <outDir>');
const graph = extractGraph(repoRoot);
writeGraphPage(path.resolve(outputArgument), path.join(repoRoot, 'fonts'), graph, await render(graph));
