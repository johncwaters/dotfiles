import fs from 'node:fs';
import path from 'node:path';

export type LayoutPoint = { x: number; y: number };
export type LayoutEdge = { id: string; sources: string[]; targets: string[]; sections?: { startPoint: LayoutPoint; endPoint: LayoutPoint; bendPoints?: LayoutPoint[]; outgoingSections?: string[] }[] };
export type LayoutNode = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labels?: { text: string; width: number; height: number }[];
  layoutOptions?: Record<string, string>;
  children?: LayoutNode[];
  edges?: LayoutEdge[];
};
export type LayoutFunction = (input: LayoutNode) => Promise<LayoutNode>;

export type PageNode = {
  id: string;
  name: string;
  kind: string;
  group: string;
  column?: number;
  hoverTitle: string;
  detailLines: string[];
  cardLine: string;
  files: string[];
  isEntry: boolean;
  isDrawn: boolean;
};
export type PageEdge = { from: string; to: string; kind: string; title: string; isSignal: boolean };
export type GraphPage = {
  title: string;
  documentTitle: string;
  fileSlug: string;
  nodes: PageNode[];
  groups: string[];
  edges: PageEdge[];
  edgeKinds: string[];
  unmarkedKinds: string[];
  layout: 'groupBoxes' | 'columns';
  summary: string;
  caption: string;
  signalNote: string;
  sectionsHtml: string;
  filesRoot: string;
  shareRows: [string, number][];
  shareLinksRowIndex: number;
  shareKeyLines: string[];
};

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function findCycles(nodeIds: string[], edges: { from: string; to: string }[]): string[][] {
  const outgoingById = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) outgoingById.get(edge.from)!.push(edge.to);
  const discoveryById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const stackedIds = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;
  function visit(id: string): void {
    discoveryById.set(id, nextIndex);
    lowLinkById.set(id, nextIndex++);
    stack.push(id);
    stackedIds.add(id);
    for (const target of outgoingById.get(id)!) {
      if (!discoveryById.has(target)) {
        visit(target);
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, lowLinkById.get(target)!));
        continue;
      }
      if (stackedIds.has(target)) lowLinkById.set(id, Math.min(lowLinkById.get(id)!, discoveryById.get(target)!));
    }
    if (lowLinkById.get(id) !== discoveryById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      stackedIds.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1) cycles.push(component.sort(compareText));
  }
  for (const id of nodeIds) {
    if (!discoveryById.has(id)) visit(id);
  }
  return cycles.sort((left, right) => compareText(left.join('\n'), right.join('\n')));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function heading(text: string, level: number = 2): string {
  return `<h${level}>${escapeHtml(text)}<span aria-hidden="true">${(level === 1 ? '=' : '-').repeat(text.length)}</span></h${level}>`;
}

export function writeGraphPage(outputDirectory: string, fontsDirectory: string, graphJson: unknown, html: string): void {
  fs.mkdirSync(path.join(outputDirectory, 'fonts'), { recursive: true });
  for (const fontName of ['CommitMono-400-Regular.otf', 'CommitMono-700-Regular.otf', 'OFL.txt']) {
    fs.copyFileSync(path.join(fontsDirectory, fontName), path.join(outputDirectory, 'fonts', fontName));
  }
  fs.writeFileSync(path.join(outputDirectory, 'graph.json'), `${JSON.stringify(graphJson, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'index.html'), html);
}

function quoteScriptText(text: string): string {
  return `'${text.replace(/[\\']/g, '\\$&')}'`;
}

const arrowMarkers = `<defs>
<marker id="arrow" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,3.5 L0,7" fill="none" stroke="var(--ink)"/></marker>
<marker id="signal-arrow" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,3.5 L0,7" fill="none" stroke="var(--signal)"/></marker>
</defs>`;

type GraphDrawing = {
  linesFor: (node: PageNode) => string[];
  hasGroupBoxes: boolean;
  nodeSpacing: number;
  layerSpacing: number;
  edgeSpacing: number;
  boxInset: number;
};

export async function renderGraphPage(page: GraphPage, layout: LayoutFunction): Promise<string> {
  const graphStyles = [
    'svg{font:13px CommitMono,monospace;color:var(--ink)}',
    'text{fill:currentColor}',
    'rect{fill:var(--ground);stroke:currentColor;stroke-width:1}',
    '.profile rect{fill:none;stroke-dasharray:3 5}',
    '.entry rect{stroke-width:2.5}',
    '.edge{fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round}',
    ...page.unmarkedKinds.map((kind) => `.kind-${kind}{stroke-dasharray:3 5}`),
    '.signal{color:var(--signal)}',
    ...page.edgeKinds.map((kind) => `.hide-${kind} .kind-${kind}{display:none}`),
  ].join('\n');
  const nodesById = new Map(page.nodes.map((node) => [node.id, node]));
  const drawnNodesOf = (group: string) => page.nodes.filter((node) => node.isDrawn && node.group === group);
  const drawnGroups = page.groups.filter((group) => drawnNodesOf(group).length > 0);
  const isColumnLayout = page.layout === 'columns';
  const pageEdgesById = new Map(page.edges.map((edge) => [`${edge.from}|${edge.to}|${edge.kind}`, edge]));
  async function drawGraph(drawing: GraphDrawing): Promise<{ width: number; height: number; shapes: string }> {
    function boxLayoutOptions(node: PageNode): Record<string, string> | undefined {
      if (isColumnLayout) return { 'elk.partitioning.partition': String(node.column ?? 0) };
      return node.isEntry ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : undefined;
    }
    function layOutBox(node: PageNode): LayoutNode {
      const lines = drawing.linesFor(node);
      return { id: node.id, width: Math.ceil(Math.max(...lines.map((line) => line.length)) * 7.8 + drawing.boxInset * 2), height: lines.length * 20 + drawing.boxInset * 2 - 6, layoutOptions: boxLayoutOptions(node) };
    }
    const layoutInput: LayoutNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.randomSeed': '1',
        'elk.spacing.nodeNode': String(drawing.nodeSpacing),
        'elk.spacing.edgeNode': String(drawing.edgeSpacing),
        'elk.spacing.edgeEdge': String(drawing.edgeSpacing * 0.66),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(drawing.layerSpacing),
        'elk.layered.spacing.edgeNodeBetweenLayers': String(drawing.edgeSpacing * 1.25),
        'elk.padding': '[top=30,left=30,bottom=30,right=30]',
        'elk.json.shapeCoords': 'ROOT',
        'elk.json.edgeCoords': 'ROOT',
        ...(isColumnLayout ? { 'elk.partitioning.activate': 'true' } : {}),
      },
      children: drawing.hasGroupBoxes ? drawnGroups.map((group) => ({
        id: `profile:${group}`,
        labels: [{ text: group, width: group.length * 7.8, height: 18 }],
        layoutOptions: {
          'elk.padding': '[top=65,left=35,bottom=35,right=35]',
          'elk.nodeLabels.placement': 'INSIDE V_TOP H_LEFT',
        },
        children: drawnNodesOf(group).map(layOutBox),
      })) : drawnGroups.flatMap(drawnNodesOf).map(layOutBox),
      edges: page.edges.map((edge) => ({ id: `${edge.from}|${edge.to}|${edge.kind}`, sources: [edge.from], targets: [edge.to] })),
    };
    const laidOut = await layout(layoutInput);
    const groupShapes: string[] = [];
    const nodeShapes: string[] = [];
    const edgeShapes: string[] = [];
    function drawEdges(edges: LayoutEdge[]): void {
      for (const layoutEdge of [...edges].sort((left, right) => compareText(left.id, right.id))) {
        const edge = pageEdgesById.get(layoutEdge.id)!;
        const signal = edge.isSignal ? ' signal' : '';
        if (!layoutEdge.sections?.length) throw new Error(`Missing route for ${layoutEdge.id}`);
        for (const section of layoutEdge.sections) {
          const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => `${point.x},${point.y}`).join(' ');
          const marker = page.unmarkedKinds.includes(edge.kind) || section.outgoingSections?.length ? '' : ` marker-end="url(#${edge.isSignal ? 'signal-arrow' : 'arrow'})"`;
          edgeShapes.push(`<polyline class="edge kind-${edge.kind}${signal}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" points="${points}"${marker}><title>${escapeHtml(edge.title)}</title></polyline>`);
        }
      }
    }
    function drawNode(layoutNode: LayoutNode): void {
      const { x = 0, y = 0, width = 0, height = 0 } = layoutNode;
      const node = nodesById.get(layoutNode.id);
      if (node) {
        const textLines = drawing.linesFor(node).map((line, lineIndex) => `<text x="${x + drawing.boxInset}" y="${y + drawing.boxInset + 9 + lineIndex * 20}"${lineIndex === 0 ? ' font-weight="700"' : ''}>${escapeHtml(line)}</text>`).join('');
        nodeShapes.push(`<g class="node${node.isEntry ? ' entry' : ''}" data-id="${escapeHtml(node.id)}"><title>${escapeHtml(node.hoverTitle)}</title><rect x="${x}" y="${y}" width="${width}" height="${height}"/>${textLines}</g>`);
        return;
      }
      if (layoutNode.id !== 'root') {
        const group = layoutNode.id.slice('profile:'.length);
        groupShapes.push(`<g class="profile"><rect x="${x}" y="${y}" width="${width}" height="${height}"/><text x="${x + 20}" y="${y + 25}" font-weight="700">${escapeHtml(group)}</text><text x="${x + 20}" y="${y + 43}" aria-hidden="true">${'-'.repeat(group.length)}</text></g>`);
      }
      for (const child of [...(layoutNode.children ?? [])].sort((left, right) => compareText(left.id, right.id))) drawNode(child);
      drawEdges(layoutNode.edges ?? []);
    }
    drawNode(laidOut);
    return { width: Math.ceil(laidOut.width ?? 1), height: Math.ceil(laidOut.height ?? 1), shapes: [...groupShapes, ...edgeShapes, ...nodeShapes].join('\n') };
  }
  const pageDrawing = await drawGraph({
    linesFor: (node) => node.detailLines,
    hasGroupBoxes: page.layout === 'groupBoxes', nodeSpacing: 55, layerSpacing: 100, edgeSpacing: 24, boxInset: 16,
  });
  const cardDrawing = await drawGraph({
    linesFor: (node) => [node.cardLine],
    hasGroupBoxes: false, nodeSpacing: 14, layerSpacing: 44, edgeSpacing: 10, boxInset: 10,
  });
  const { width, height } = pageDrawing;
  const legend = page.edgeKinds.map((kind) => `<li><button type="button" data-kind="${kind}" aria-pressed="true">[${kind}]</button></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.documentTitle)}</title>
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
#graph-view{overflow:auto;max-height:88vh;cursor:grab}
#graph-view.is-panning{cursor:grabbing;user-select:none}
#graph-view .graph{max-width:none}
.view{display:flex;gap:16px;margin:0 0 10px;padding:0;list-style:none}
.view button,.share button,.legend button,.reader button,.open-node{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.share button:disabled{opacity:.6;cursor:progress}
.view button[aria-pressed="true"],.legend button[aria-pressed="true"],.reader-files button[aria-pressed="true"]{font-weight:700;text-decoration:underline}
.legend button[aria-pressed="false"]{opacity:.45}
.graph.is-focusing .edge{opacity:.12}
.graph.is-focusing .edge.is-focus{opacity:1;stroke-width:2.2}
.tag{opacity:.75}
.workspace.is-reading{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,44%);gap:28px;align-items:start}
.reader{position:sticky;top:0;max-height:100vh;overflow:auto;padding:0 0 28px}
.reader h2{margin-top:0}
.reader-files{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 10px;padding:0;list-style:none}
.reader pre{margin:0;padding-top:14px;border-top:1px solid currentColor;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.graph .node{cursor:pointer}
.graph .node:focus{outline:none}
.graph .node:focus-visible rect,.graph .node.is-selected rect{stroke:var(--signal);stroke-width:3}
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
${heading(page.title, 1)}
<p>${page.summary}.</p>
${heading('link kinds')}
<ul class="legend">${legend}</ul>
<p class="signal">${page.signalNote}</p>
<p class="share"><button type="button" id="share-image">[share image]</button> <span id="share-status" role="status"></span></p>
<div class="workspace" id="workspace">
<figure>
<ul class="view"><li><button type="button" id="zoom-fit" aria-pressed="true">[fit]</button></li><li><button type="button" id="zoom-out">[zoom out]</button></li><li><button type="button" id="zoom-in">[zoom in]</button></li><li><span id="zoom-status" role="status">fit</span> <span class="tag">ctrl+wheel or pinch to zoom, drag to pan</span></li></ul>
<div class="scroll" id="graph-view" tabindex="0" role="region" aria-label="Scrollable ${page.title}">
<svg class="graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${page.summary}">
${arrowMarkers}
${pageDrawing.shapes}
</svg>
</div>
<figcaption>${page.caption}</figcaption>
</figure>
<aside class="reader" id="reader" hidden aria-labelledby="reader-title">
<h2 id="reader-title" tabindex="-1"></h2>
<p class="tag" id="reader-meta"></p>
<ul class="reader-files" id="reader-files"></ul>
<p><button type="button" id="reader-close">[close]</button></p>
<pre id="reader-text"></pre>
</aside>
</div>
${page.sectionsHtml}
</main>
<script>
const graphView = document.getElementById('graph-view');
const graphSvg = document.querySelector('svg.graph');
const zoomFitControl = document.getElementById('zoom-fit');
const zoomStatus = document.getElementById('zoom-status');
const graphWidth = ${width};
const maxGraphScale = 4;
const zoomStep = 1.25;
let graphScale = 1;
let isFitted = true;

function fitScale() {
  return Math.min(graphView.clientWidth / graphWidth, (window.innerHeight * 0.88) / ${height});
}

function setGraphScale(nextScale, anchorX = graphView.clientWidth / 2, anchorY = graphView.clientHeight / 2) {
  const minGraphScale = fitScale();
  const clampedScale = Math.min(maxGraphScale, Math.max(minGraphScale, nextScale));
  const contentX = (graphView.scrollLeft + anchorX) / graphScale;
  const contentY = (graphView.scrollTop + anchorY) / graphScale;
  graphScale = clampedScale;
  graphSvg.style.width = graphWidth * graphScale + 'px';
  graphView.scrollLeft = contentX * graphScale - anchorX;
  graphView.scrollTop = contentY * graphScale - anchorY;
  isFitted = clampedScale === minGraphScale;
  zoomFitControl.setAttribute('aria-pressed', String(isFitted));
  zoomStatus.textContent = isFitted ? 'fit' : Math.round(graphScale * 100) + '%';
}

zoomFitControl.addEventListener('click', () => setGraphScale(0));
document.getElementById('zoom-out').addEventListener('click', () => setGraphScale(graphScale / zoomStep));
document.getElementById('zoom-in').addEventListener('click', () => setGraphScale(graphScale * zoomStep));
graphView.addEventListener('wheel', (wheelEvent) => {
  if (!wheelEvent.ctrlKey) return;
  wheelEvent.preventDefault();
  const viewBounds = graphView.getBoundingClientRect();
  setGraphScale(graphScale * Math.exp(-wheelEvent.deltaY * 0.002), wheelEvent.clientX - viewBounds.left, wheelEvent.clientY - viewBounds.top);
}, { passive: false });
new ResizeObserver(() => {
  setGraphScale(isFitted ? 0 : graphScale);
}).observe(graphView);

let dragStart;
let didPan = false;
graphView.addEventListener('pointerdown', (pointerEvent) => {
  if (pointerEvent.button !== 0 || pointerEvent.pointerType === 'touch') return;
  dragStart = { x: pointerEvent.clientX, y: pointerEvent.clientY, scrollLeft: graphView.scrollLeft, scrollTop: graphView.scrollTop };
  didPan = false;
});
graphView.addEventListener('pointermove', (pointerEvent) => {
  if (!dragStart) return;
  if ((pointerEvent.buttons & 1) === 0) {
    endDrag();
    return;
  }
  const movedX = pointerEvent.clientX - dragStart.x;
  const movedY = pointerEvent.clientY - dragStart.y;
  if (!didPan && Math.hypot(movedX, movedY) < 5) return;
  if (!didPan) {
    didPan = true;
    graphView.classList.add('is-panning');
    graphView.setPointerCapture(pointerEvent.pointerId);
  }
  graphView.scrollLeft = dragStart.scrollLeft - movedX;
  graphView.scrollTop = dragStart.scrollTop - movedY;
});
function endDrag() {
  dragStart = undefined;
  graphView.classList.remove('is-panning');
}
graphView.addEventListener('pointerup', endDrag);
graphView.addEventListener('pointercancel', endDrag);
graphView.addEventListener('click', (clickEvent) => {
  if (!didPan) return;
  didPan = false;
  clickEvent.stopPropagation();
}, true);
for (const kindChip of document.querySelectorAll('.legend button')) {
  kindChip.addEventListener('click', () => {
    const isShown = kindChip.getAttribute('aria-pressed') !== 'true';
    kindChip.setAttribute('aria-pressed', String(isShown));
    graphSvg.classList.toggle('hide-' + kindChip.dataset.kind, !isShown);
  });
}
const edgesByNodeId = new Map();
for (const edgeLine of graphSvg.querySelectorAll('.edge')) {
  for (const endpointId of [edgeLine.dataset.from, edgeLine.dataset.to]) {
    if (!edgesByNodeId.has(endpointId)) edgesByNodeId.set(endpointId, []);
    edgesByNodeId.get(endpointId).push(edgeLine);
  }
}
const readableNodeById = ${JSON.stringify(Object.fromEntries(page.nodes.map((node) => [node.id, { name: node.name, kind: node.kind, profile: node.group, files: node.files }]))).replace(/<\//g, '<\\/')};
const fileTextByPath = ${JSON.stringify(Object.fromEntries(page.nodes.flatMap((node) => node.files).map((filePath) => [filePath, fs.readFileSync(path.join(page.filesRoot, filePath), 'utf8')]))).replace(/<\//g, '<\\/')};
const workspace = document.getElementById('workspace');
const reader = document.getElementById('reader');
const readerTitle = document.getElementById('reader-title');
const readerFiles = document.getElementById('reader-files');
const readerText = document.getElementById('reader-text');
let readerOpener;

function showFile(filePath) {
  readerText.textContent = fileTextByPath[filePath];
  for (const fileTab of readerFiles.querySelectorAll('button')) fileTab.setAttribute('aria-pressed', String(fileTab.dataset.path === filePath));
}

function centerInGraphView(nodeBox) {
  const boxBounds = nodeBox.getBoundingClientRect();
  const viewBounds = graphView.getBoundingClientRect();
  graphView.scrollLeft += boxBounds.left + boxBounds.width / 2 - (viewBounds.left + graphView.clientWidth / 2);
  graphView.scrollTop += boxBounds.top + boxBounds.height / 2 - (viewBounds.top + graphView.clientHeight / 2);
}

function openReader(nodeId, opener) {
  const readableNode = readableNodeById[nodeId];
  readerOpener = opener;
  for (const selectedBox of graphSvg.querySelectorAll('.node.is-selected')) selectedBox.classList.remove('is-selected');
  const selectedBox = graphSvg.querySelector('.node[data-id="' + CSS.escape(nodeId) + '"]');
  selectedBox?.classList.add('is-selected');
  readerTitle.textContent = readableNode.name;
  const underline = document.createElement('span');
  underline.setAttribute('aria-hidden', 'true');
  underline.textContent = '-'.repeat(readableNode.name.length);
  readerTitle.append(underline);
  document.getElementById('reader-meta').textContent = readableNode.kind + ' · ' + readableNode.profile + ' · ' + readableNode.files[0];
  const folder = readableNode.files[0].slice(0, readableNode.files[0].lastIndexOf('/') + 1);
  readerFiles.replaceChildren(...readableNode.files.map((filePath) => {
    const fileTab = document.createElement('button');
    fileTab.type = 'button';
    fileTab.dataset.path = filePath;
    fileTab.textContent = '[' + filePath.slice(folder.length) + ']';
    fileTab.addEventListener('click', () => showFile(filePath));
    const fileItem = document.createElement('li');
    fileItem.append(fileTab);
    return fileItem;
  }));
  showFile(readableNode.files[0]);
  reader.hidden = false;
  workspace.classList.add('is-reading');
  if (selectedBox && !isFitted) centerInGraphView(selectedBox);
  reader.scrollTop = 0;
  readerTitle.focus({ preventScroll: true });
}

function closeReader() {
  if (reader.hidden) return;
  reader.hidden = true;
  workspace.classList.remove('is-reading');
  for (const selectedBox of graphSvg.querySelectorAll('.node.is-selected')) selectedBox.classList.remove('is-selected');
  readerOpener?.focus();
}

document.getElementById('reader-close').addEventListener('click', closeReader);
document.addEventListener('keydown', (keyEvent) => {
  if (keyEvent.key === 'Escape') closeReader();
});
for (const openButton of document.querySelectorAll('.open-node')) openButton.addEventListener('click', () => openReader(openButton.dataset.id, openButton));
for (const nodeBox of graphSvg.querySelectorAll('.node')) {
  const nodeEdges = edgesByNodeId.get(nodeBox.dataset.id) ?? [];
  nodeBox.setAttribute('tabindex', '0');
  nodeBox.setAttribute('role', 'button');
  nodeBox.setAttribute('aria-label', 'Read ' + readableNodeById[nodeBox.dataset.id].name);
  nodeBox.addEventListener('click', () => openReader(nodeBox.dataset.id, nodeBox));
  nodeBox.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
    keyEvent.preventDefault();
    openReader(nodeBox.dataset.id, nodeBox);
  });
  nodeBox.addEventListener('mouseenter', () => {
    graphSvg.classList.add('is-focusing');
    for (const edgeLine of nodeEdges) edgeLine.classList.add('is-focus');
  });
  nodeBox.addEventListener('mouseleave', () => {
    graphSvg.classList.remove('is-focusing');
    for (const edgeLine of nodeEdges) edgeLine.classList.remove('is-focus');
  });
}
const shareControl = document.getElementById('share-image');
const shareStatus = document.getElementById('share-status');
const shareCard = ${JSON.stringify({
    title: page.title,
    graphStyles,
    darkPalette: '--ground:#181818;--ink:#eeece6;--signal:#ffa476',
    graph: { width: cardDrawing.width, height: cardDrawing.height, body: `${arrowMarkers}${cardDrawing.shapes}` },
    countRows: page.shareRows,
    linkCountByKind: Object.fromEntries(page.edgeKinds.map((kind) => [kind, page.edges.filter((edge) => edge.kind === kind).length])),
    unconnectedCount: page.nodes.filter((node) => !node.isDrawn).length,
  })};
const shareWidth = 1600;
const shareHeight = 900;
const shareMargin = 64;
const graphRegion = { x: 500, y: shareMargin, width: shareWidth - 500 - shareMargin, height: shareHeight - shareMargin * 2 };
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

function hiddenKinds() {
  return [...graphSvg.classList].filter((className) => className.startsWith('hide-')).map((className) => className.slice('hide-'.length));
}

function placeGraph() {
  const { width: graphWidth, height: graphHeight, body } = shareCard.graph;
  const scale = Math.min(graphRegion.width / graphWidth, graphRegion.height / graphHeight);
  const placedX = graphRegion.x + (graphRegion.width - graphWidth * scale) / 2;
  const placedY = graphRegion.y + (graphRegion.height - graphHeight * scale) / 2;
  return '<svg x="' + placedX + '" y="' + placedY + '" width="' + graphWidth * scale + '" height="' + graphHeight * scale + '" viewBox="0 0 ' + graphWidth + ' ' + graphHeight + '">'
    + '<g class="' + hiddenKinds().map((kind) => 'hide-' + kind).join(' ') + '">' + body + '</g></svg>';
}

function countRow(label, count, baselineY) {
  return '<text x="' + shareMargin + '" y="' + baselineY + '" font-size="22" xml:space="preserve">' + escapeXml(label) + ' ' + '.'.repeat(Math.max(2, 17 - label.length)) + ' <tspan font-weight="700">' + String(count).padStart(3) + '</tspan></text>';
}

function composeStats() {
  const hidden = hiddenKinds();
  const shownKinds = Object.keys(shareCard.linkCountByKind).filter((kind) => !hidden.includes(kind));
  const linkCount = shownKinds.reduce((total, kind) => total + shareCard.linkCountByKind[kind], 0);
  const rows = [...shareCard.countRows.slice(0, ${page.shareLinksRowIndex}), ['links', linkCount], ...shareCard.countRows.slice(${page.shareLinksRowIndex})];
  const keyLines = [${page.shareKeyLines.map(quoteScriptText).join(', ')}, shareCard.unconnectedCount + ' unconnected, not drawn'];
  if (hidden.length) keyLines.unshift('links shown: ' + (shownKinds.join(', ') || 'none'));
  return rows.map(([label, count], rowIndex) => countRow(label, count, 268 + rowIndex * 42)).join('')
    + keyLines.map((line, lineIndex) => '<text x="' + shareMargin + '" y="' + (shareHeight - shareMargin - (keyLines.length - 1 - lineIndex) * 28) + '" font-size="17" opacity=".7"' + (line.startsWith('accent') ? ' class="signal"' : '') + '>' + escapeXml(line) + '</text>').join('');
}

async function composeShareSvg() {
  const fontFaces = await loadFontFaces();
  const title = escapeXml(shareCard.title);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + shareWidth + '" height="' + shareHeight + '" viewBox="0 0 ' + shareWidth + ' ' + shareHeight + '">'
    + '<style>' + fontFaces + 'svg{' + shareCard.darkPalette + '}' + shareCard.graphStyles + '</style>'
    + '<rect width="' + shareWidth + '" height="' + shareHeight + '" style="fill:var(--ground);stroke:none"/>'
    + '<text x="' + shareMargin + '" y="120" font-size="52" font-weight="700">' + title + '</text>'
    + '<text x="' + shareMargin + '" y="172" font-size="52" font-weight="700" aria-hidden="true">' + '='.repeat(shareCard.title.length) + '</text>'
    + composeStats()
    + placeGraph()
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
    await downloads.save({ filename: '${page.fileSlug}.png', data: pngBlob });
    return 'Saved ${page.fileSlug}.png.';
  }
  if (window.claude) return 'Saving is not available in this view.';
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(pngBlob);
  downloadLink.download = '${page.fileSlug}.png';
  downloadLink.click();
  setTimeout(() => URL.revokeObjectURL(downloadLink.href), 0);
  return 'Downloaded ${page.fileSlug}.png.';
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
