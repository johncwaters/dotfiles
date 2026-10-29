import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeHtml } from '../../lib/graph-page.mts';

export type Side = 'left' | 'right' | 'top' | 'bottom';
export type BoxKind = 'box' | 'ext' | 'ghost' | 'final' | 'frame';
export type EdgeStyle = 'solid' | 'dashed' | 'fail' | 'join' | 'ghost';

export type Box = {
  id: string;
  title: string;
  lines?: string[];
  column?: string;
  x?: number;
  width?: number;
  y: number;
  height?: number;
  kind?: BoxKind;
  lane?: string;
  tags?: string[];
};

export type Edge = {
  from: string;
  to?: string;
  bus?: string;
  fromSide?: Side;
  toSide?: Side;
  fromAt?: number;
  toAt?: number;
  channel?: number;
  label?: string;
  labelOn?: 'first' | 'last' | 'longest';
  style?: EdgeStyle;
};

export type Bus = { id: string; to: string; channel: number; toSide?: Side; toAt?: number; style?: EdgeStyle };
export type Lane = { color: string; tag?: string };
export type Heading = { x: number; y: number; text: string };
export type NoteCard = { title: string; itemsHtml: string[] };

export type Board = {
  title: string;
  subtitleHtml?: string;
  captionHtml: string;
  ariaLabel: string;
  width: number;
  height: number;
  columns: Record<string, { x: number; width: number }>;
  lanes?: Record<string, Lane>;
  headings?: Heading[];
  boxes: Box[];
  edges: Edge[];
  buses?: Bus[];
  notes?: NoteCard[];
};

type Point = [number, number];
type Segment = [Point, Point];
type Bounds = [number, number, number, number];
type PlacedBox = Required<Pick<Box, 'id' | 'title' | 'x' | 'width' | 'y'>> & { lines: string[]; kind: BoxKind; lane: string; tags: string[]; height: number };
type DrawnPath = { id: string; style: EdgeStyle; points: Point[]; hasArrowhead: boolean };
type PlacedTag = { label: string; lane: string; x: number; box: PlacedBox; bounds: Bounds };
type TextItem = { owner: string; x: number; y: number; text: string; fontPx: number; cssClass: string; anchor: 'start' | 'middle' | 'end'; isRotated: boolean; fill: string; styleExtra: string };
type Layout = { boxesById: Map<string, PlacedBox>; edges: Edge[]; busesById: Map<string, Bus>; paths: DrawnPath[]; texts: TextItem[]; tags: PlacedTag[]; junctions: Point[]; problems: string[]; warnings: string[] };

const titleFontPx = 17;
const lineFontPx = 13.5;
const noteFontPx = 12.5;
const headingFontPx = 15;
const averageGlyphEm = 0.47;
const paddingX = 14;
const titleBlockPx = 30;
const lineBlockPx = 21;
const paddingBottomPx = 12;
const labelGapPx = 5;
const textClearancePx = 2;
const labelSlideFractions = [0.5, 0.35, 0.65, 0.2, 0.8];
const labelFillByStyle: Partial<Record<EdgeStyle, string>> = { fail: 'var(--fail)', join: 'var(--join)', ghost: 'var(--ghost)' };
const pathStyleByEdgeStyle: Record<EdgeStyle, { attributes: string; marker: string }> = {
  solid: { attributes: 'class="wire"', marker: 'arrow' },
  dashed: { attributes: 'class="wire dash"', marker: 'arrow' },
  fail: { attributes: 'class="wire dash" style="stroke:var(--fail)"', marker: 'arrow-red' },
  join: { attributes: 'class="wire dash" style="stroke:var(--join)"', marker: 'arrow-green' },
  ghost: { attributes: 'class="wire dash" style="stroke:var(--ghost)"', marker: 'arrow-grey' },
};
const arrowMarkers = ([['arrow', 'var(--ink)'], ['arrow-red', 'var(--fail)'], ['arrow-green', 'var(--join)'], ['arrow-grey', 'var(--ghost)']] as const)
  .map(([name, color]) => `<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:${color}"/></marker>`)
  .join('');

function boxHeight(box: Box): number {
  return box.height ?? titleBlockPx + lineBlockPx * (box.lines?.length ?? 0) + paddingBottomPx;
}

export function boxBottom(box: Box): number {
  return box.y + boxHeight(box);
}

export type BoardHelpers = { stack: typeof stack; row: typeof row; boxBottom: typeof boxBottom };
export type DrawBoard = (helpers: BoardHelpers) => Board;

export function stack(boxes: Box[], startY: number, gapPx: number): Box[] {
  let nextY = startY;
  for (const box of boxes) {
    box.y = nextY;
    nextY = boxBottom(box) + gapPx;
  }
  return boxes;
}

export function row(boxes: Box[], startX: number, gapPx: number): Box[] {
  let nextX = startX;
  for (const box of boxes) {
    box.x = nextX;
    nextX += (box.width ?? 0) + gapPx;
  }
  return boxes;
}

function textWidthPx(text: string, fontPx: number): number {
  return text.length * fontPx * averageGlyphEm;
}

function textItem(owner: string, x: number, y: number, text: string, fontPx: number, cssClass: string, extras: Partial<TextItem> = {}): TextItem {
  return { owner, x, y, text, fontPx, cssClass, anchor: 'start', isRotated: false, fill: '', styleExtra: '', ...extras };
}

function textBounds(item: TextItem): Bounds {
  const width = textWidthPx(item.text, item.fontPx);
  const ascent = item.fontPx * 0.8;
  const descent = item.fontPx * 0.25;
  const alongStart = { start: 0, middle: -width / 2, end: -width }[item.anchor];
  if (item.isRotated) return [item.x - ascent, item.y - alongStart - width, item.x + descent, item.y - alongStart];
  return [item.x + alongStart, item.y - ascent, item.x + alongStart + width, item.y + descent];
}

function renderText(item: TextItem): string {
  const rotation = item.isRotated ? ` transform="rotate(-90 ${item.x.toFixed(1)} ${item.y.toFixed(1)})"` : '';
  const style = [item.fill ? `fill:${item.fill}` : '', item.styleExtra].filter(Boolean).join(';');
  const styleAttribute = style ? ` style="${style}"` : '';
  return `<text class="${item.cssClass}" x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" text-anchor="${item.anchor}"${rotation}${styleAttribute}>${escapeHtml(item.text)}</text>`;
}

function placeBoxes(board: Board, problems: string[]): Map<string, PlacedBox> {
  const boxesById = new Map<string, PlacedBox>();
  for (const box of board.boxes) {
    if (boxesById.has(box.id)) problems.push(`two boxes share the id ${JSON.stringify(box.id)}`);
    const column = box.column === undefined ? undefined : board.columns[box.column];
    if (box.column !== undefined && !column) problems.push(`${box.id}: unknown column ${JSON.stringify(box.column)}`);
    const x = box.x ?? column?.x;
    const width = box.width ?? column?.width;
    if (x === undefined || width === undefined) {
      problems.push(`${box.id}: needs a column or both x and width`);
      continue;
    }
    if (box.lane && !board.lanes?.[box.lane]) problems.push(`${box.id}: unknown lane ${JSON.stringify(box.lane)}`);
    for (const tag of box.tags ?? []) {
      if (!board.lanes?.[tag]?.tag) problems.push(`${box.id}: tag ${JSON.stringify(tag)} names no lane with a tag`);
    }
    boxesById.set(box.id, { id: box.id, title: box.title, x, width, y: box.y, height: boxHeight(box), lines: box.lines ?? [], kind: box.kind ?? 'box', lane: box.lane ?? '', tags: box.tags ?? [] });
  }
  return boxesById;
}

function right(box: PlacedBox): number {
  return box.x + box.width;
}

function bottom(box: PlacedBox): number {
  return box.y + box.height;
}

function anchor(box: PlacedBox, side: Side, at: number): Point {
  if (side === 'left') return [box.x, box.y + box.height * at];
  if (side === 'right') return [right(box), box.y + box.height * at];
  if (side === 'top') return [box.x + box.width * at, box.y];
  return [box.x + box.width * at, bottom(box)];
}

function isSideways(side: Side): boolean {
  return side === 'left' || side === 'right';
}

function orthogonalPath(start: Point, end: Point, fromSide: Side, toSide: Side, channel: number | undefined): Point[] {
  const exitsSideways = isSideways(fromSide);
  const entersSideways = isSideways(toSide);
  if (exitsSideways && entersSideways) {
    if (Math.abs(start[1] - end[1]) < 0.5) return [start, end];
    const channelX = channel ?? (start[0] + end[0]) / 2;
    return [start, [channelX, start[1]], [channelX, end[1]], end];
  }
  if (!exitsSideways && !entersSideways) {
    if (Math.abs(start[0] - end[0]) < 0.5) return [start, end];
    const channelY = channel ?? (start[1] + end[1]) / 2;
    return [start, [start[0], channelY], [end[0], channelY], end];
  }
  if (exitsSideways) return [start, [end[0], start[1]], end];
  return [start, [start[0], end[1]], end];
}

function route(edge: Edge, layout: Layout): Point[] {
  const fromSide = edge.fromSide ?? 'right';
  const start = anchor(layout.boxesById.get(edge.from)!, fromSide, edge.fromAt ?? 0.5);
  if (edge.bus) return [start, [layout.busesById.get(edge.bus)!.channel, start[1]]];
  const target = layout.boxesById.get(edge.to!)!;
  const toSide = edge.toSide ?? 'left';
  const end = anchor(target, toSide, edge.toAt ?? 0.5);
  const canRunStraight = isSideways(fromSide) && isSideways(toSide) && edge.toAt === undefined && target.y < start[1] && start[1] < bottom(target);
  return orthogonalPath(start, canRunStraight ? [end[0], start[1]] : end, fromSide, toSide, edge.channel);
}

function busTrunk(bus: Bus, feederEnds: Point[], layout: Layout): Point[] {
  const entry = anchor(layout.boxesById.get(bus.to)!, bus.toSide ?? 'left', bus.toAt ?? 0.5);
  const ys = [...feederEnds.map((point) => point[1]), entry[1]];
  return [[bus.channel, Math.min(...ys)], [bus.channel, Math.max(...ys)], [bus.channel, entry[1]], entry];
}

function pathSegments(points: Point[]): Segment[] {
  return points.slice(1).map((point, index): Segment => [points[index], point]).filter(([first, second]) => first[0] !== second[0] || first[1] !== second[1]);
}

function borderSegments(box: PlacedBox): Segment[] {
  const topLeft: Point = [box.x, box.y];
  const topRight: Point = [right(box), box.y];
  const bottomLeft: Point = [box.x, bottom(box)];
  const bottomRight: Point = [right(box), bottom(box)];
  return [[topLeft, topRight], [topRight, bottomRight], [bottomLeft, bottomRight], [topLeft, bottomLeft]];
}

function segmentHitsRectangle([[x1, y1], [x2, y2]]: Segment, [left, top, rightEdge, bottomEdge]: Bounds): boolean {
  if (Math.abs(y1 - y2) < 0.5) return top < y1 && y1 < bottomEdge && Math.min(x1, x2) < rightEdge && Math.max(x1, x2) > left;
  return left < x1 && x1 < rightEdge && Math.min(y1, y2) < bottomEdge && Math.max(y1, y2) > top;
}

function segmentCrossesBox(segment: Segment, box: PlacedBox): boolean {
  return segmentHitsRectangle(segment, [box.x + 2, box.y + 2, right(box) - 2, bottom(box) - 2]);
}

function segmentTouchesText(segment: Segment, bounds: Bounds): boolean {
  return segmentHitsRectangle(segment, [bounds[0] - textClearancePx, bounds[1] - textClearancePx, bounds[2] + textClearancePx, bounds[3] + textClearancePx]);
}

function boundsOverlap(first: Bounds, second: Bounds): boolean {
  return first[0] < second[2] && second[0] < first[2] && first[1] < second[3] && second[1] < first[3];
}

function boxBounds(box: PlacedBox): Bounds {
  return [box.x, box.y, right(box), bottom(box)];
}

function boxTextItems(box: PlacedBox): TextItem[] {
  if (box.kind === 'frame') return [textItem(box.id, box.x + 20, box.y + 32, box.title, 20, 't', { styleExtra: 'font-size:20px' })];
  const hasSmallTitle = box.kind === 'ext' || box.kind === 'ghost';
  const titleY = box.y + (box.kind === 'ghost' ? box.height / 2 + 5 : 24);
  const titleClass = `${hasSmallTitle ? 's' : 't'}${box.kind === 'ghost' ? ' ghost-t' : ''}`;
  const lineItems = box.lines.map((line, index) => {
    const isNote = line.startsWith('~');
    const isSmall = isNote || box.kind === 'ext';
    const indentPx = isNote && box.kind !== 'ext' ? 16 : 0;
    return textItem(box.id, box.x + paddingX + indentPx, box.y + titleBlockPx + lineBlockPx * index + 15, line.replace(/^~/, ''), isSmall ? noteFontPx : lineFontPx, isSmall ? 'x' : 's');
  });
  return [textItem(box.id, box.x + paddingX, titleY, box.title, hasSmallTitle ? lineFontPx : titleFontPx, titleClass), ...lineItems];
}

function placeTags(box: PlacedBox, lanes: Record<string, Lane>): PlacedTag[] {
  return [...box.tags].reverse().map((lane, index) => {
    const x = right(box) - 48 - 44 * index;
    return { label: lanes[lane]?.tag ?? lane, lane, x, box, bounds: [x, box.y + 8, x + 40, box.y + 26] };
  });
}

function segmentLengthPx([[x1, y1], [x2, y2]]: Segment): number {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

function labelCandidates(edge: Edge, owner: string, points: Point[], extraSegments: Segment[]): TextItem[] {
  const segments = pathSegments(points);
  const preferred = { first: segments.slice(0, 1), last: segments.slice(-1), longest: [] }[edge.labelOn ?? 'first'];
  const byLength = [...segments].sort((first, second) => segmentLengthPx(second) - segmentLengthPx(first));
  const fill = labelFillByStyle[edge.style ?? 'solid'] ?? 'var(--label)';
  const label = edge.label!;
  return [...preferred, ...byLength, ...extraSegments].flatMap(([[x1, y1], [x2, y2]]) => labelSlideFractions.flatMap((fraction) => {
    const middleX = x1 + (x2 - x1) * fraction;
    const middleY = y1 + (y2 - y1) * fraction;
    if (Math.abs(y1 - y2) < 0.5) {
      return [
        textItem(owner, middleX, middleY - labelGapPx, label, noteFontPx, 'x', { anchor: 'middle', fill }),
        textItem(owner, middleX, middleY + labelGapPx + 10, label, noteFontPx, 'x', { anchor: 'middle', fill }),
      ];
    }
    return [
      textItem(owner, middleX - labelGapPx, middleY, label, noteFontPx, 'x', { anchor: 'middle', isRotated: true, fill }),
      textItem(owner, middleX + labelGapPx + 10, middleY, label, noteFontPx, 'x', { anchor: 'middle', isRotated: true, fill }),
      textItem(owner, middleX + labelGapPx + 2, middleY + 4, label, noteFontPx, 'x', { fill }),
      textItem(owner, middleX - labelGapPx - 2, middleY + 4, label, noteFontPx, 'x', { anchor: 'end', fill }),
    ];
  }));
}

function allLineSegments(layout: Layout): { owner: string; segment: Segment }[] {
  const pathLines = layout.paths.flatMap((drawn) => pathSegments(drawn.points).map((segment) => ({ owner: drawn.id, segment })));
  const borderLines = [...layout.boxesById.values()].flatMap((box) => borderSegments(box).map((segment) => ({ owner: box.id, segment })));
  return [...pathLines, ...borderLines];
}

function solidBoxes(layout: Layout): PlacedBox[] {
  return [...layout.boxesById.values()].filter((box) => box.kind !== 'frame');
}

function isClearSpot(candidate: TextItem, layout: Layout, lines: { segment: Segment }[], board: Board): boolean {
  const bounds = textBounds(candidate);
  if (bounds[0] < 0 || bounds[1] < 0 || bounds[2] > board.width || bounds[3] > board.height) return false;
  if (lines.some(({ segment }) => segmentTouchesText(segment, bounds))) return false;
  if (solidBoxes(layout).some((box) => boundsOverlap(bounds, boxBounds(box)))) return false;
  return !layout.texts.some((other) => boundsOverlap(bounds, textBounds(other)));
}

function placeLabels(layout: Layout, board: Board): void {
  const lines = allLineSegments(layout);
  layout.edges.forEach((edge, index) => {
    if (!edge.label) return;
    const points = layout.paths[index].points;
    const end = points[points.length - 1];
    const trunkSegments = layout.paths.filter((drawn) => drawn.id === `bus:${edge.bus}`).flatMap((drawn) => pathSegments(drawn.points));
    const distanceToEnd = (segment: Segment) => Math.min(Math.abs(segment[0][1] - end[1]), Math.abs(segment[1][1] - end[1]));
    const nearestTrunkSegments = [...trunkSegments].sort((first, second) => distanceToEnd(first) - distanceToEnd(second));
    const clearSpot = labelCandidates(edge, `label${index}`, points, nearestTrunkSegments).find((candidate) => isClearSpot(candidate, layout, lines, board));
    if (!clearSpot) {
      layout.problems.push(`no clear spot for label ${JSON.stringify(edge.label)} on ${describeEdge(edge)}`);
      return;
    }
    layout.texts.push(clearSpot);
  });
}

function describeEdge(edge: Edge): string {
  return `${edge.from}->${edge.to ?? `bus ${edge.bus}`}`;
}

function describePath(pathId: string, layout: Layout): string {
  if (pathId.startsWith('bus:')) return `bus ${pathId.slice(4)} -> ${layout.busesById.get(pathId.slice(4))!.to}`;
  return describeEdge(layout.edges[Number(pathId.slice(4))]);
}

function pathEndpointIds(pathId: string, layout: Layout): Set<string> {
  if (pathId.startsWith('bus:')) return new Set([layout.busesById.get(pathId.slice(4))!.to]);
  const edge = layout.edges[Number(pathId.slice(4))];
  return new Set([edge.from, edge.to ?? '']);
}

function findUnknownReferences(board: Board, boxesById: Map<string, PlacedBox>, busesById: Map<string, Bus>): string[] {
  const edgeProblems = board.edges.flatMap((edge) => {
    const problems = [edge.from, edge.to].filter((id): id is string => id !== undefined && !boxesById.has(id)).map((id) => `${describeEdge(edge)}: unknown box ${JSON.stringify(id)}`);
    if (edge.bus && !busesById.has(edge.bus)) problems.push(`${describeEdge(edge)}: unknown bus ${JSON.stringify(edge.bus)}`);
    if (!edge.bus === !edge.to) problems.push(`${describeEdge(edge)}: needs exactly one of to or bus`);
    return problems;
  });
  const busProblems = [...busesById.values()].flatMap((bus) => {
    const problems = boxesById.has(bus.to) ? [] : [`bus ${bus.id}: unknown box ${JSON.stringify(bus.to)}`];
    if (!board.edges.some((edge) => edge.bus === bus.id)) problems.push(`bus ${bus.id}: has no feeders`);
    return problems;
  });
  return [...edgeProblems, ...busProblems];
}

function checkCanvas(layout: Layout, board: Board): void {
  for (const box of layout.boxesById.values()) {
    if (box.x < 0 || box.y < 0 || right(box) > board.width || bottom(box) > board.height) layout.problems.push(`${box.id}: outside the ${board.width}x${board.height} canvas`);
  }
}

function checkText(layout: Layout): void {
  for (const item of layout.texts) {
    const box = layout.boxesById.get(item.owner);
    if (!box || box.kind === 'frame') continue;
    const [left, , rightEdge] = textBounds(item);
    if (left < box.x + 4 || rightEdge > right(box) - 4) layout.problems.push(`${box.id}: text overflows (${JSON.stringify(item.text)})`);
  }
  layout.texts.forEach((first, index) => {
    const firstBounds = textBounds(first);
    for (const second of layout.texts.slice(index + 1)) {
      if (boundsOverlap(firstBounds, textBounds(second))) layout.problems.push(`text overlaps: ${JSON.stringify(first.text)} and ${JSON.stringify(second.text)}`);
    }
    for (const tag of layout.tags) {
      if (first.owner === tag.box.id && boundsOverlap(firstBounds, tag.bounds)) layout.problems.push(`${tag.box.id}: text ${JSON.stringify(first.text)} runs under tag ${tag.label}`);
    }
  });
  const lines = allLineSegments(layout);
  for (const item of layout.texts.filter((text) => text.owner.startsWith('label'))) {
    const touchedLine = lines.find(({ segment }) => segmentTouchesText(segment, textBounds(item)));
    if (touchedLine) layout.problems.push(`label ${JSON.stringify(item.text)} touches line ${touchedLine.owner}`);
  }
}

function checkBoxes(layout: Layout): void {
  const boxes = solidBoxes(layout);
  boxes.forEach((first, index) => {
    for (const second of boxes.slice(index + 1)) {
      if (boundsOverlap(boxBounds(first), boxBounds(second))) layout.problems.push(`boxes overlap: ${first.id} and ${second.id}`);
    }
  });
  for (const drawn of layout.paths) {
    const endpointIds = pathEndpointIds(drawn.id, layout);
    for (const box of boxes) {
      if (endpointIds.has(box.id)) continue;
      if (pathSegments(drawn.points).some((segment) => segmentCrossesBox(segment, box))) layout.problems.push(`${describePath(drawn.id, layout)} runs through ${box.id}`);
    }
  }
}

function checkSharedEndpoints(layout: Layout): void {
  const ownerByPoint = new Map<string, string>();
  for (const drawn of layout.paths) {
    const isBusTrunk = drawn.id.startsWith('bus:');
    if (!isBusTrunk && layout.edges[Number(drawn.id.slice(4))].bus) continue;
    const endpoints = isBusTrunk ? [drawn.points[drawn.points.length - 1]] : [drawn.points[0], drawn.points[drawn.points.length - 1]];
    for (const point of endpoints) {
      const key = `${Math.round(point[0])},${Math.round(point[1])}`;
      const owner = ownerByPoint.get(key);
      if (owner) layout.problems.push(`${describePath(drawn.id, layout)} and ${describePath(owner, layout)} share the point ${key}`);
      ownerByPoint.set(key, drawn.id);
    }
  }
}

function isHorizontal([[, y1], [, y2]]: Segment): boolean {
  return Math.abs(y1 - y2) < 0.5;
}

function findCrossings(layout: Layout): string[] {
  const busByEdgePathId = new Map(layout.edges.flatMap((edge, index) => edge.bus ? [[`edge${index}`, `bus:${edge.bus}`] as const] : []));
  const groupOf = (pathId: string) => busByEdgePathId.get(pathId) ?? pathId;
  const segments = layout.paths.flatMap((drawn) => pathSegments(drawn.points).map((segment) => ({ pathId: drawn.id, segment })));
  return segments.flatMap((first, index) => segments.slice(index + 1).flatMap((second) => {
    if (groupOf(first.pathId) === groupOf(second.pathId)) return [];
    if (isHorizontal(first.segment) === isHorizontal(second.segment)) return [];
    const [horizontal, vertical] = isHorizontal(first.segment) ? [first.segment, second.segment] : [second.segment, first.segment];
    const xLow = Math.min(horizontal[0][0], horizontal[1][0]);
    const xHigh = Math.max(horizontal[0][0], horizontal[1][0]);
    const yLow = Math.min(vertical[0][1], vertical[1][1]);
    const yHigh = Math.max(vertical[0][1], vertical[1][1]);
    const crosses = xLow + 1 < vertical[0][0] && vertical[0][0] < xHigh - 1 && yLow + 1 < horizontal[0][1] && horizontal[0][1] < yHigh - 1;
    return crosses ? [`crossing: ${describePath(first.pathId, layout)} x ${describePath(second.pathId, layout)}`] : [];
  }));
}

export function layOut(board: Board): Layout {
  const problems: string[] = [];
  const boxesById = placeBoxes(board, problems);
  const busesById = new Map((board.buses ?? []).map((bus) => [bus.id, bus]));
  const layout: Layout = { boxesById, edges: board.edges, busesById, paths: [], texts: [], tags: [], junctions: [], problems, warnings: [] };
  problems.push(...findUnknownReferences(board, boxesById, busesById));
  if (problems.length) return layout;
  layout.paths = board.edges.map((edge, index) => ({ id: `edge${index}`, style: edge.style ?? 'solid', points: route(edge, layout), hasArrowhead: !edge.bus }));
  layout.junctions = layout.paths.filter((_, index) => board.edges[index].bus).map((drawn) => drawn.points[drawn.points.length - 1]);
  for (const bus of busesById.values()) {
    const feederEnds = layout.paths.filter((_, index) => board.edges[index].bus === bus.id).map((drawn) => drawn.points[drawn.points.length - 1]);
    layout.paths.push({ id: `bus:${bus.id}`, style: bus.style ?? 'solid', points: busTrunk(bus, feederEnds, layout), hasArrowhead: true });
  }
  layout.texts = [...boxesById.values()].flatMap(boxTextItems);
  layout.texts.push(...(board.headings ?? []).map((heading) => textItem('heading', heading.x, heading.y, heading.text, headingFontPx, 'x', { styleExtra: 'font-size:15px;letter-spacing:1px' })));
  layout.tags = [...boxesById.values()].flatMap((box) => placeTags(box, board.lanes ?? {}));
  placeLabels(layout, board);
  checkCanvas(layout, board);
  checkText(layout);
  checkBoxes(layout);
  checkSharedEndpoints(layout);
  layout.warnings.push(...findCrossings(layout));
  return layout;
}

function renderBoxShape(box: PlacedBox): string {
  if (box.kind === 'frame') return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="16" class="frame"/>`;
  const shapeClass = { box: 'box', ext: 'ext', ghost: 'ghost', final: 'box final' }[box.kind];
  const laneClass = box.lane ? ` lane-${box.lane}` : '';
  return `<rect class="${shapeClass}${laneClass}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="10"/>`;
}

function renderPath(drawn: DrawnPath): string {
  const { attributes, marker } = pathStyleByEdgeStyle[drawn.style];
  const pathData = `M${drawn.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}`;
  return `<path ${attributes} d="${pathData}"${drawn.hasArrowhead ? ` marker-end="url(#${marker})"` : ''}/>`;
}

function renderSvg(layout: Layout, board: Board): string {
  const boxes = [...layout.boxesById.values()];
  const parts = [
    ...boxes.filter((box) => box.kind === 'frame').map(renderBoxShape),
    ...layout.paths.map(renderPath),
    ...layout.junctions.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" class="junction"/>`),
    ...boxes.filter((box) => box.kind !== 'frame').map(renderBoxShape),
    ...layout.tags.map((tag) => `<g class="tag"><rect class="lane-fill-${tag.lane}" x="${tag.x}" y="${tag.box.y + 8}" width="40" height="18" rx="9"/><text x="${tag.x + 10}" y="${tag.box.y + 21}">${escapeHtml(tag.label)}</text></g>`),
    ...layout.texts.map(renderText),
  ];
  return `<svg viewBox="0 0 ${board.width} ${board.height}" role="img" aria-label="${escapeHtml(board.ariaLabel)}"><defs>${arrowMarkers}</defs>${parts.join('')}</svg>`;
}

function renderLaneCss(lanes: Record<string, Lane>): string {
  return Object.entries(lanes).map(([lane, { color }]) => `.lane-${lane} { stroke:${color}; } .lane-fill-${lane} { fill:${color}; }`).join('\n  ');
}

function renderNotes(notes: NoteCard[]): string {
  if (!notes.length) return '';
  const cards = notes.map((card) => `<div class="card"><h2>${escapeHtml(card.title)}</h2><ul>${card.itemsHtml.map((item) => `<li>${item}</li>`).join('')}</ul></div>`);
  return `<section class="notes">${cards.join('')}</section>`;
}

function renderPage(board: Board, svg: string): string {
  const template = fs.readFileSync(fileURLToPath(new URL('./template.html', import.meta.url)), 'utf8');
  const slots: Record<string, string> = {
    title: escapeHtml(board.title),
    subtitle: board.subtitleHtml ? `<p class="sub">${board.subtitleHtml}</p>` : '',
    laneCss: renderLaneCss(board.lanes ?? {}),
    svg,
    caption: board.captionHtml,
    notes: renderNotes(board.notes ?? []),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, slot: string) => slots[slot]);
}

export const boardHelpers: BoardHelpers = { stack, row, boxBottom };

async function screenshotPage(pagePath: string, screenshotPath: string, board: Board): Promise<void> {
  const { chromium } = await import('playwright-core');
  const { launchCaptureBrowser } = await import('../../lib/headless-chrome.mjs');
  const browser = await launchCaptureBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: board.width + 100, height: 900 } });
    await page.goto(pathToFileURL(path.resolve(pagePath)).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const hasKalam = await page.evaluate(() => document.fonts.check('17px Kalam'));
    if (!hasKalam) console.log('warning: Kalam did not load, so text widths in the screenshot differ from the ones the checks measured');
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const [boardPath, outputPath, flag, screenshotPath] = process.argv.slice(2);
  const hasValidScreenshotFlag = flag === undefined || (flag === '--screenshot' && screenshotPath !== undefined);
  if (!boardPath || !outputPath || !hasValidScreenshotFlag) {
    console.error('usage: node render.ts <board.ts> <out.html> [--screenshot <out.png>]');
    process.exit(2);
  }
  const drawBoard: DrawBoard = (await import(pathToFileURL(path.resolve(boardPath)).href)).default;
  const board = drawBoard(boardHelpers);
  const layout = layOut(board);
  for (const warning of layout.warnings) console.log(warning);
  if (layout.problems.length) {
    console.error(layout.problems.join('\n'));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, renderPage(board, renderSvg(layout, board)));
  console.log(`ok: ${layout.boxesById.size} boxes, ${layout.paths.length} paths, ${layout.texts.length} text items, no overlaps`);
  if (screenshotPath) await screenshotPage(outputPath, screenshotPath, board);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
