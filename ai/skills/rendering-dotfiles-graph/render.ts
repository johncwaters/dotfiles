import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { escapeHtml, heading, renderGraphPage, writeGraphPage } from '../../lib/graph-page.mts';
import type { LayoutNode } from '../../lib/graph-page.mts';
import { extractDotfilesGraph } from './extract.ts';
import type { DotfilesGraph, EdgeKind, NodeKind } from './extract.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const edgeKinds: EdgeKind[] = ['runs', 'extends', 'installs', 'sources', 'loads', 'reads', 'links', 'copies', 'stubs', 'renders'];
const nodeKinds: NodeKind[] = ['profile', 'topic', 'lib', 'profileFile', 'packageGroup', 'shellFragment', 'target'];
const columnNames = ['profiles', 'topics', 'libs and files', 'home targets'];
const maxBoxesPerSubcolumn = 14;

async function layOutWithElk(input: LayoutNode): Promise<LayoutNode> {
  const options = { ...input.layoutOptions, 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' };
  return await new ELK().layout({ ...input, layoutOptions: options } as ElkNode) as LayoutNode;
}

function partitionsByNodeId(graph: DotfilesGraph, drawnIds: Set<string>): Map<string, number> {
  const partitionById = new Map<string, number>();
  let firstPartitionOfColumn = 0;
  for (let column = 0; column < columnNames.length; column++) {
    const columnNodes = graph.nodes.filter((node) => node.column === column && drawnIds.has(node.id));
    columnNodes.forEach((node, nodeIndex) => partitionById.set(node.id, firstPartitionOfColumn + Math.floor(nodeIndex / maxBoxesPerSubcolumn)));
    firstPartitionOfColumn += Math.max(1, Math.ceil(columnNodes.length / maxBoxesPerSubcolumn));
  }
  return partitionById;
}

function signalList(label: string, items: string[]): string {
  if (!items.length) return `<p>${escapeHtml(label)}: none</p>`;
  return `<p>${escapeHtml(label)}: ${items.length}</p><ul>${items.map((item) => `<li class="signal">${escapeHtml(item)}</li>`).join('')}</ul>`;
}

async function render(graph: DotfilesGraph): Promise<string> {
  const connectedIds = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  const targetIds = new Set(graph.edges.map((edge) => edge.to));
  const entryIds = new Set(graph.edges.map((edge) => edge.from).filter((id) => !targetIds.has(id)));
  const partitionById = partitionsByNodeId(graph, connectedIds);
  const cycleByNodeId = new Map(graph.signals.sourceCycles.flatMap((cycle, cycleIndex) => cycle.map((id) => [id, cycleIndex] as const)));
  const { unrunTopics, unsourcedLibs, unreferencedFiles, sourceCycles } = graph.signals;
  const edgeRows = graph.edges.map((edge) => `<tr><td>${escapeHtml(edge.from)}</td><td>${edge.kind}${edge.order ? ` #${edge.order}` : ''}</td><td>${escapeHtml(edge.to)}</td></tr>`).join('\n');
  const kindRows = nodeKinds.map((kind) => `<tr><th scope="row">${kind}</th><td>${graph.nodes.filter((node) => node.kind === kind).length}</td></tr>`).join('\n');
  const sectionsHtml = `${heading('signals')}
${signalList('topics no profile runs', unrunTopics)}
${signalList('libs nothing sources', unsourcedLibs)}
${signalList('topic files nothing references', unreferencedFiles)}
${signalList('source cycles', sourceCycles.map((cycle) => cycle.join(', ')))}
${signalList('nodes with no edges, not drawn', graph.nodes.filter((node) => !connectedIds.has(node.id)).map((node) => node.id))}
${heading('all edges')}
<div class="scroll" tabindex="0" role="region" aria-label="All edges"><table><thead><tr><th scope="col">from</th><th scope="col">kind</th><th scope="col">to</th></tr></thead><tbody>
${edgeRows}
</tbody></table></div>
${heading('node kinds')}
<div class="scroll" tabindex="0" role="region" aria-label="Node counts"><table><thead><tr><th scope="col">kind</th><th scope="col">count</th></tr></thead><tbody>
${kindRows}
</tbody></table></div>`;
  return renderGraphPage({
    title: 'dotfiles graph',
    documentTitle: 'Dotfiles graph',
    fileSlug: 'dotfiles-graph',
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      group: columnNames[node.column]!,
      column: partitionById.get(node.id) ?? 0,
      hoverTitle: `${node.id} / ${node.path}`,
      detailLines: node.lines,
      cardLine: node.name,
      files: node.files,
      isEntry: entryIds.has(node.id),
      isDrawn: connectedIds.has(node.id),
    })),
    groups: columnNames,
    edges: graph.edges.map((edge) => {
      const isCycle = edge.kind === 'sources' && cycleByNodeId.has(edge.from) && cycleByNodeId.get(edge.from) === cycleByNodeId.get(edge.to);
      return { from: edge.from, to: edge.to, kind: edge.kind, title: `${edge.from} ${edge.kind}${edge.order ? ` #${edge.order}` : ''} ${edge.to}${isCycle ? ' (cycle)' : ''}`, isSignal: isCycle };
    }),
    edgeKinds,
    unmarkedKinds: ['reads'],
    layout: 'columns',
    summary: `${graph.nodes.length} nodes, ${graph.edges.length} typed edges, ${unrunTopics.length} unrun topics, ${unsourcedLibs.length} unsourced libs, ${unreferencedFiles.length} unreferenced files, ${sourceCycles.length} source cycles`,
    caption: 'dotfiles graph / columns run left to right: profiles, topics, libs and files, then $HOME targets; arrows point from the file that runs, sources, reads or places a node to that node; topic boxes list each profile\'s run order. Hover a box or edge for its path or kind; click a box to read its files.',
    signalNote: 'signal accent: edges inside a source cycle, and every listed signal.',
    sectionsHtml,
    filesRoot: repoRoot,
    shareRows: [['profiles', graph.nodes.filter((node) => node.kind === 'profile').length], ['topics', graph.nodes.filter((node) => node.kind === 'topic').length], ['libs', graph.nodes.filter((node) => node.kind === 'lib').length], ['home targets', graph.nodes.filter((node) => node.kind === 'target').length]],
    shareLinksRowIndex: 4,
    shareKeyLines: ['▶ starting point', 'accent: source cycles'],
  }, layOutWithElk);
}

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('Usage: node render.ts <outDir>');
const graph = extractDotfilesGraph(repoRoot);
writeGraphPage(path.resolve(outputArgument), path.join(repoRoot, 'fonts'), graph, await render(graph));
