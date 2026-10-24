import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import { compareText, extractGraph } from './extract.ts';
import type { EdgeKind, GraphNode, SkillGraph } from './extract.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dashByKind: Record<EdgeKind, string> = { mentions: '', extends: '14 6', spawns: '5 5', runs: '1 5', names: '12 5 2 5' };

const graphStyles = `svg{font:13px CommitMono,monospace;color:var(--ink)}
text{fill:currentColor}
rect{fill:var(--ground);stroke:currentColor;stroke-width:1}
.profile rect{fill:none;stroke-dasharray:3 5}
.entry rect{stroke-width:2.5}
.edge{fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round}
.signal{color:var(--signal)}`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

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

function nodeLines(node: GraphNode, isEntry: boolean): string[] {
  const lines = [node.name, describeNode(node)];
  if (isEntry) lines.push(describeStart(node));
  return lines;
}

function heading(text: string, level: number = 2): string {
  return `<h${level}>${escapeHtml(text)}<span aria-hidden="true">${(level === 1 ? '=' : '-').repeat(text.length)}</span></h${level}>`;
}

async function render(graph: SkillGraph): Promise<string> {
  const isolatedIds = new Set(graph.isolated);
  const targetIds = new Set(graph.edges.map((edge) => edge.to));
  const entryIds = new Set(graph.edges.map((edge) => edge.from).filter((id) => !targetIds.has(id)));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const cycleByNodeId = new Map(graph.cycles.flatMap((cycle, cycleIndex) => cycle.map((id) => [id, cycleIndex] as const)));
  const profiles = [...new Set(graph.nodes.map((node) => node.profile))].sort(compareText);
  const nodesByProfile = new Map(profiles.map((profile) => [profile, graph.nodes.filter((node) => node.profile === profile)]));
  const layoutInput: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1',
      'elk.spacing.nodeNode': '55',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: profiles.filter((profile) => nodesByProfile.get(profile)!.some((node) => !isolatedIds.has(node.id))).map((profile) => ({
      id: `profile:${profile}`,
      labels: [{ text: profile, width: profile.length * 7.8, height: 18 }],
      layoutOptions: {
        'elk.padding': '[top=65,left=35,bottom=35,right=35]',
        'elk.nodeLabels.placement': 'INSIDE V_TOP H_LEFT',
      },
      children: nodesByProfile.get(profile)!.filter((node) => !isolatedIds.has(node.id)).map((node) => {
        const lines = nodeLines(node, entryIds.has(node.id));
        const layoutOptions = entryIds.has(node.id) ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : undefined;
        return { id: node.id, width: Math.ceil(Math.max(...lines.map((line) => line.length)) * 7.8 + 32), height: lines.length * 20 + 26, layoutOptions };
      }),
    })),
    edges: graph.edges.map((edge) => ({ id: `${edge.from}|${edge.to}|${edge.kind}`, sources: [edge.from], targets: [edge.to] })),
  };
  const layout = await new ELK().layout(layoutInput);
  const groupShapes: string[] = [];
  const nodeShapes: string[] = [];
  const edgeShapes: string[] = [];
  const graphEdgesById = new Map(graph.edges.map((edge) => [`${edge.from}|${edge.to}|${edge.kind}`, edge]));
  function drawEdges(edges: ElkExtendedEdge[]): void {
    for (const layoutEdge of [...edges].sort((left, right) => compareText(left.id, right.id))) {
      const edge = graphEdgesById.get(layoutEdge.id)!;
      const isCycle = cycleByNodeId.has(edge.from) && cycleByNodeId.get(edge.from) === cycleByNodeId.get(edge.to);
      const signal = isCycle ? ' signal' : '';
      const title = `${edge.from} ${edge.kind} ${edge.to}${isCycle ? ' (cycle)' : ''}`;
      if (!layoutEdge.sections?.length) throw new Error(`Missing route for ${layoutEdge.id}`);
      for (const section of layoutEdge.sections) {
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => `${point.x},${point.y}`).join(' ');
        const marker = section.outgoingSections?.length ? '' : ` marker-end="url(#${isCycle ? 'signal-arrow' : 'arrow'})"`;
        edgeShapes.push(`<polyline class="edge${signal}" points="${points}" stroke-dasharray="${dashByKind[edge.kind]}"${marker}><title>${escapeHtml(title)}</title></polyline>`);
      }
    }
  }
  function drawNode(layoutNode: ElkNode): void {
    const { x = 0, y = 0, width = 0, height = 0 } = layoutNode;
    const node = nodesById.get(layoutNode.id);
    if (node) {
      const isEntry = entryIds.has(node.id);
      const textLines = nodeLines(node, isEntry).map((line, lineIndex) => `<text x="${x + 16}" y="${y + 25 + lineIndex * 20}"${lineIndex === 0 ? ' font-weight="700"' : ''}>${escapeHtml(line)}</text>`).join('');
      nodeShapes.push(`<g class="node${isEntry ? ' entry' : ''}"><title>${escapeHtml(`${node.id} / ${node.path}`)}</title><rect x="${x}" y="${y}" width="${width}" height="${height}"/>${textLines}</g>`);
      return;
    }
    if (layoutNode.id !== 'root') {
      const profile = layoutNode.id.slice('profile:'.length);
      groupShapes.push(`<g class="profile"><rect x="${x}" y="${y}" width="${width}" height="${height}"/><text x="${x + 20}" y="${y + 25}" font-weight="700">${escapeHtml(profile)}</text><text x="${x + 20}" y="${y + 43}" aria-hidden="true">${'-'.repeat(profile.length)}</text></g>`);
    }
    for (const child of [...(layoutNode.children ?? [])].sort((left, right) => compareText(left.id, right.id))) drawNode(child);
    drawEdges(layoutNode.edges ?? []);
  }
  drawNode(layout);
  const width = Math.ceil(layout.width ?? 1);
  const height = Math.ceil(layout.height ?? 1);
  const summary = `${graph.nodes.length} nodes, ${graph.edges.length} typed edges, ${profiles.length} profiles, ${graph.isolated.length} unconnected, ${graph.cycles.length} mutual mention groups`;
  const legend = (Object.keys(dashByKind) as EdgeKind[]).map((kind) => `<li><svg viewBox="0 0 52 12" width="52" height="12" aria-hidden="true"><line class="edge" x1="1" y1="6" x2="51" y2="6" stroke-dasharray="${dashByKind[kind]}"/></svg> ${kind}</li>`).join('');
  const isolatedList = graph.isolated.length ? profiles.flatMap((profile) => {
    const isolatedMembers = nodesByProfile.get(profile)!.filter((node) => isolatedIds.has(node.id));
    if (!isolatedMembers.length) return [];
    return [`<p>${escapeHtml(profile)}</p><ul>${isolatedMembers.map((node) => `<li class="signal">${escapeHtml(node.name)} <span class="tag">${escapeHtml(describeNode(node))}</span></li>`).join('')}</ul>`];
  }).join('\n') : '<p>unconnected: none</p>';
  const cycleList = graph.cycles.length ? `<ul>${graph.cycles.map((cycle) => `<li class="signal">mutual mentions: ${cycle.map(escapeHtml).join(', ')}</li>`).join('')}</ul>` : '<p>cycles: none</p>';
  const edgeRows = graph.edges.map((edge) => `<tr><td>${escapeHtml(edge.from)}</td><td>${edge.kind}</td><td>${escapeHtml(edge.to)}</td></tr>`).join('\n');
  const kinds = ['skill', 'agent', 'workflow', 'hook'] as const;
  const profileRows = profiles.map((profile) => {
    const members = nodesByProfile.get(profile)!;
    return `<tr><th scope="row">${escapeHtml(profile)}</th>${kinds.map((kind) => `<td>${members.filter((node) => node.kind === kind).length}</td>`).join('')}<td>${members.length}</td></tr>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill tree</title>
<style>
@font-face{font-family:CommitMono;src:url("fonts/CommitMono-400-Regular.otf") format("opentype");font-weight:400;font-display:swap}
@font-face{font-family:CommitMono;src:url("fonts/CommitMono-700-Regular.otf") format("opentype");font-weight:700;font-display:swap}
:root{color-scheme:light dark;--ground:#faf9f6;--ink:#242424;--signal:#a43d15}
@media(prefers-color-scheme:dark){:root{--ground:#181818;--ink:#eeece6;--signal:#ffa476}}
*{box-sizing:border-box}
body{margin:0;padding:28px;font:13px/1.6 CommitMono,monospace;color:var(--ink);background:var(--ground)}
h1,h2{font:700 13px/1.4 CommitMono,monospace;margin:28px 0 14px}
h1 span,h2 span{display:block;white-space:pre}
figure{margin:18px 0 28px}
.scroll{overflow-x:auto;max-width:100%}
.graph{display:block;width:100%;height:auto}
.scroll.is-actual-size .graph{width:${width}px;max-width:none}
.view{display:flex;gap:16px;margin:0 0 10px;padding:0;list-style:none}
.view button,.share button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.share button:disabled{opacity:.6;cursor:progress}
.view button[aria-pressed="true"]{font-weight:700;text-decoration:underline}
.tag{opacity:.75}
${graphStyles}
.legend{display:flex;flex-wrap:wrap;gap:12px 24px;padding:0;list-style:none}
figcaption{margin-top:12px}
table{border-collapse:collapse;text-align:left;font:inherit}
th,td{padding:6px 22px 6px 0;vertical-align:top;border-bottom:1px solid currentColor;white-space:nowrap}
a{color:inherit}
</style>
</head>
<body>
<main>
${heading('skill tree', 1)}
<p>${summary}.</p>
${heading('edge legend')}
<ul class="legend">${legend}</ul>
<p class="signal">signal accent: edges inside a mutual mention group, and unconnected nodes in the signals list.</p>
<p class="share"><button type="button" id="share-image">[share image]</button> <span id="share-status" role="status"></span></p>
<figure>
<ul class="view"><li><button type="button" data-view="fit" aria-pressed="true">[fit width]</button></li><li><button type="button" data-view="actual" aria-pressed="false">[actual size]</button></li></ul>
<div class="scroll" id="graph-view" tabindex="0" role="region" aria-label="Scrollable skill tree">
<svg class="graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${summary}">
<defs>
<marker id="arrow" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,3.5 L0,7" fill="none" stroke="var(--ink)"/></marker>
<marker id="signal-arrow" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,3.5 L0,7" fill="none" stroke="var(--signal)"/></marker>
</defs>
${groupShapes.join('\n')}
${edgeShapes.join('\n')}
${nodeShapes.join('\n')}
</svg>
</div>
<figcaption>skill tree / arrows point from the file that names a node to that node; ▶ marks a starting point, a box nothing points into, pinned to the left edge; boxes group profiles; unconnected nodes are listed under signals. Hover a box or edge for its path or kind.</figcaption>
</figure>
${heading('signals')}
<p>unconnected: ${graph.isolated.length} / mutual mention groups: ${graph.cycles.length}</p>
${isolatedList}
${cycleList}
${heading('all edges')}
<div class="scroll" tabindex="0" role="region" aria-label="All edges"><table><thead><tr><th scope="col">from</th><th scope="col">kind</th><th scope="col">to</th></tr></thead><tbody>
${edgeRows}
</tbody></table></div>
${heading('profiles')}
<div class="scroll" tabindex="0" role="region" aria-label="Profile counts"><table><thead><tr><th scope="col">profile</th>${kinds.map((kind) => `<th scope="col">${kind}</th>`).join('')}<th scope="col">total</th></tr></thead><tbody>
${profileRows}
</tbody></table></div>
</main>
<script>
const graphView = document.getElementById('graph-view');
for (const viewButton of document.querySelectorAll('.view button')) {
  viewButton.addEventListener('click', () => {
    graphView.classList.toggle('is-actual-size', viewButton.dataset.view === 'actual');
    for (const otherButton of document.querySelectorAll('.view button')) otherButton.setAttribute('aria-pressed', String(otherButton === viewButton));
  });
}
const shareControl = document.getElementById('share-image');
const shareStatus = document.getElementById('share-status');
const shareCard = ${JSON.stringify({ title: 'skill tree', summary: `${summary}.`, graphStyles, darkPalette: '--ground:#181818;--ink:#eeece6;--signal:#ffa476' })};
const shareWidth = 1600;
const shareHeight = 900;
const shareMargin = 64;
const graphTop = 200;
const saveStatusByErrorCode = { declined: 'Not saved.', rate_limited: 'A save prompt is already open.', too_large: 'The image is too large to save here.' };
const downloadsReady = window.claude?.use ? window.claude.use('downloads') : Promise.resolve(undefined);
let fontFacesReady;

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function inlineFontFace(fileName, weight) {
  const response = await fetch('fonts/' + fileName);
  if (!response.ok) throw new Error('Font ' + fileName + ' did not load.');
  const fontUrl = await readAsDataUrl(await response.blob());
  return '@font-face{font-family:CommitMono;src:url(' + fontUrl + ') format("opentype");font-weight:' + weight + '}';
}

function loadFontFaces() {
  fontFacesReady ??= Promise.all([inlineFontFace('CommitMono-400-Regular.otf', 400), inlineFontFace('CommitMono-700-Regular.otf', 700)])
    .then((fontFaces) => fontFaces.join(''))
    .catch((fontError) => {
      fontFacesReady = undefined;
      throw fontError;
    });
  return fontFacesReady;
}

function placeGraph(graphSvg) {
  const [, , graphWidth, graphHeight] = graphSvg.getAttribute('viewBox').split(' ').map(Number);
  const availableWidth = shareWidth - shareMargin * 2;
  const availableHeight = shareHeight - graphTop - shareMargin;
  const scale = Math.min(availableWidth / graphWidth, availableHeight / graphHeight);
  const placedGraph = graphSvg.cloneNode(true);
  placedGraph.removeAttribute('class');
  placedGraph.setAttribute('x', String(shareMargin + (availableWidth - graphWidth * scale) / 2));
  placedGraph.setAttribute('y', String(graphTop));
  placedGraph.setAttribute('width', String(graphWidth * scale));
  placedGraph.setAttribute('height', String(graphHeight * scale));
  return new XMLSerializer().serializeToString(placedGraph);
}

async function composeShareSvg() {
  const fontFaces = await loadFontFaces();
  const title = escapeXml(shareCard.title);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + shareWidth + '" height="' + shareHeight + '" viewBox="0 0 ' + shareWidth + ' ' + shareHeight + '">'
    + '<style>' + fontFaces + 'svg{' + shareCard.darkPalette + '}' + shareCard.graphStyles + '</style>'
    + '<rect width="' + shareWidth + '" height="' + shareHeight + '" style="fill:var(--ground);stroke:none"/>'
    + '<text x="' + shareMargin + '" y="96" font-size="34" font-weight="700">' + title + '</text>'
    + '<text x="' + shareMargin + '" y="130" font-size="34" font-weight="700">' + '='.repeat(shareCard.title.length) + '</text>'
    + '<text x="' + shareMargin + '" y="168" font-size="20">' + escapeXml(shareCard.summary) + '</text>'
    + placeGraph(document.querySelector('svg.graph'))
    + '</svg>';
}

async function drawSharePng() {
  const shareImage = new Image();
  shareImage.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(await composeShareSvg());
  await shareImage.decode();
  const canvas = document.createElement('canvas');
  canvas.width = shareWidth;
  canvas.height = shareHeight;
  canvas.getContext('2d').drawImage(shareImage, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((pngBlob) => (pngBlob ? resolve(pngBlob) : reject(new Error('The image could not be encoded.'))), 'image/png'));
}

async function saveSharePng(pngBlob) {
  const downloads = await downloadsReady;
  if (downloads) {
    shareStatus.textContent = 'Waiting for your confirmation.';
    await downloads.save({ filename: 'skill-tree.png', data: pngBlob });
    return 'Saved skill-tree.png.';
  }
  if (window.claude) return 'Saving is not available in this view.';
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(pngBlob);
  downloadLink.download = 'skill-tree.png';
  downloadLink.click();
  setTimeout(() => URL.revokeObjectURL(downloadLink.href), 0);
  return 'Downloaded skill-tree.png.';
}

shareControl.addEventListener('click', async () => {
  shareControl.disabled = true;
  shareStatus.textContent = 'Drawing the image.';
  try {
    shareStatus.textContent = await saveSharePng(await drawSharePng());
  } catch (shareError) {
    shareStatus.textContent = saveStatusByErrorCode[shareError?.code] ?? 'Could not make the image.';
  }
  shareControl.disabled = false;
});
</script>
<footer><p>CommitMono, SIL OFL 1.1, (c) 2023 Eigil Nikolajsen. Licence at <a href="fonts/OFL.txt">fonts/OFL.txt</a>.</p></footer>
</body>
</html>
`;
}

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('Usage: node render.ts <outDir>');
const outputDirectory = path.resolve(outputArgument);
const graph = extractGraph(repoRoot);
const html = await render(graph);
fs.mkdirSync(path.join(outputDirectory, 'fonts'), { recursive: true });
for (const fontName of ['CommitMono-400-Regular.otf', 'CommitMono-700-Regular.otf', 'OFL.txt']) {
  fs.copyFileSync(path.join(repoRoot, 'fonts', fontName), path.join(outputDirectory, 'fonts', fontName));
}
fs.writeFileSync(path.join(outputDirectory, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
fs.writeFileSync(path.join(outputDirectory, 'index.html'), html);
