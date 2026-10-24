import fs from 'node:fs';
import path from 'node:path';

export type NodeKind = 'skill' | 'agent' | 'workflow' | 'hook';
export type EdgeKind = 'mentions' | 'extends' | 'runs' | 'spawns' | 'names';
export type GraphNode = {
  id: string;
  name: string;
  kind: NodeKind;
  profile: string;
  path: string;
  bytes: number;
  files: string[];
  subskills?: number;
  references?: number;
  events?: { event: string; matcher: string }[];
};
export type GraphEdge = { from: string; to: string; kind: EdgeKind };
export type SkillGraph = { nodes: GraphNode[]; edges: GraphEdge[]; isolated: string[]; cycles: string[][] };

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function entries(directory: string): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
}

function markdownFiles(directory: string): string[] {
  return entries(directory).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

type MarkdownTokens = { names: Set<string>; workflows: Set<string>; agents: Set<string>; prefixes: Set<string> };

function tokenizeMarkdown(markdown: string): MarkdownTokens {
  const tokens: MarkdownTokens = { names: new Set(), workflows: new Set(), agents: new Set(), prefixes: new Set() };
  const pattern = /(?<!`)`\/?(?<name>[a-zA-Z0-9][a-zA-Z0-9._-]*)`(?!`)|\bWorkflow\s*\((?<workflow>[\s\S]*?)\)|\bsubagent_type[\s`'"*]*[:=][\s`'"*]*(?<agent>[a-zA-Z0-9][a-zA-Z0-9._-]*)|\b(?<prefix>[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*-)/g;
  for (const match of markdown.matchAll(pattern)) {
    const { name, workflow, agent, prefix } = match.groups!;
    if (name) {
      tokens.names.add(name);
      if (name.endsWith('-')) tokens.prefixes.add(name);
    }
    if (workflow !== undefined) {
      for (const namedCall of workflow.matchAll(/\bname\s*:\s*(['"])([^'"]+)\1/g)) tokens.workflows.add(namedCall[2]);
    }
    if (agent) tokens.agents.add(agent);
    if (prefix) tokens.prefixes.add(prefix);
  }
  return tokens;
}

function tokenizeSource(source: string): { literals: Set<string>; agents: Set<string> } {
  const literals = new Set<string>();
  const agents = new Set<string>();
  let isAgentValue = false;
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<quote>['"`])(?<literal>(?:\\[\s\S]|(?!\k<quote>)[^\\])*?)\k<quote>|(?<agentProperty>\bagentType\s*:)/g;
  for (const match of source.matchAll(pattern)) {
    if (match.groups?.agentProperty) {
      isAgentValue = true;
      continue;
    }
    const literal = match.groups?.literal;
    if (literal === undefined) continue;
    literals.add(literal);
    if (isAgentValue) agents.add(literal);
    isAgentValue = false;
  }
  return { literals, agents };
}

function findCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const outgoingById = new Map(nodes.map((node) => [node.id, [] as string[]]));
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
  for (const node of nodes) {
    if (!discoveryById.has(node.id)) visit(node.id);
  }
  return cycles.sort((left, right) => compareText(left.join('\n'), right.join('\n')));
}

export function extractGraph(repoRoot: string): SkillGraph {
  const nodes: GraphNode[] = [];
  const markdownByNode = new Map<GraphNode, MarkdownTokens[]>();
  const prefixesByNode = new Map<GraphNode, Set<string>>();
  const sourceByNode = new Map<GraphNode, ReturnType<typeof tokenizeSource>>();
  const hooksByPath = new Map<string, GraphNode>();
  const toRepoPath = (filePath: string) => path.relative(repoRoot, filePath).split(path.sep).join('/');
  function addNode(kind: NodeKind, name: string, profile: string, filePath: string): GraphNode {
    const node: GraphNode = { id: `${kind}:${name}`, name, kind, profile, path: toRepoPath(filePath), bytes: fs.statSync(filePath).size, files: [toRepoPath(filePath)] };
    nodes.push(node);
    return node;
  }
  const profileNames = entries(path.join(repoRoot, 'profiles')).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const surfaces = [
    { profile: 'shared', directory: path.join(repoRoot, 'ai'), settings: 'settings.base.json' },
    ...profileNames.map((profile) => ({ profile, directory: path.join(repoRoot, 'profiles', profile), settings: 'settings.overlay.json' })),
  ];
  for (const { profile, directory, settings } of surfaces) {
    for (const entry of entries(path.join(directory, 'skills'))) {
      if (!entry.isDirectory()) continue;
      const skillDirectory = path.join(directory, 'skills', entry.name);
      const skillPath = path.join(skillDirectory, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const node = addNode('skill', entry.name, profile, skillPath);
      const subskills = markdownFiles(path.join(skillDirectory, 'subskills'));
      const references = markdownFiles(path.join(skillDirectory, 'references'));
      node.subskills = subskills.length;
      node.references = references.length;
      node.files.push(...[...subskills, ...references].map(toRepoPath));
      const tokenSets = [skillPath, ...subskills, ...references].map((filePath) => tokenizeMarkdown(fs.readFileSync(filePath, 'utf8')));
      markdownByNode.set(node, tokenSets);
      prefixesByNode.set(node, tokenSets[0].prefixes);
    }
    for (const entry of entries(path.join(directory, 'agents'))) {
      if (entry.isFile() && entry.name.endsWith('.md')) addNode('agent', entry.name.slice(0, -3), profile, path.join(directory, 'agents', entry.name));
    }
    if (profile === 'shared') {
      for (const entry of entries(path.join(directory, 'workflows'))) {
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const filePath = path.join(directory, 'workflows', entry.name);
        const node = addNode('workflow', entry.name.slice(0, -3), profile, filePath);
        sourceByNode.set(node, tokenizeSource(fs.readFileSync(filePath, 'utf8')));
      }
    }
    const settingsPath = path.join(directory, settings);
    if (!fs.existsSync(settingsPath)) continue;
    const hookSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks ?? {};
    for (const event of Object.keys(hookSettings).sort(compareText)) {
      for (const registration of hookSettings[event]) {
        for (const hook of registration.hooks ?? []) {
          if (hook.type !== 'command') continue;
          const script = hook.command.match(/\/(profile-hooks|hooks)\/([^\s'";|&]+)/);
          if (!script) throw new Error(`Unresolved hook command in ${path.relative(repoRoot, settingsPath)}: ${hook.command}`);
          const hookDirectory = script[1] === 'profile-hooks' ? directory : path.join(repoRoot, 'ai');
          const filePath = path.join(hookDirectory, 'hooks', script[2]);
          let node = hooksByPath.get(filePath);
          if (!node) {
            node = addNode('hook', path.basename(filePath), profile, filePath);
            node.events = [];
            hooksByPath.set(filePath, node);
            sourceByNode.set(node, tokenizeSource(fs.readFileSync(filePath, 'utf8')));
          }
          const matcher = registration.matcher ?? '';
          if (!node.events!.some((existing) => existing.event === event && existing.matcher === matcher)) node.events!.push({ event, matcher });
        }
      }
    }
  }
  const nodesByInitialId = new Map<string, GraphNode[]>();
  const nodesByName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const collisions = nodesByInitialId.get(node.id) ?? [];
    collisions.push(node);
    nodesByInitialId.set(node.id, collisions);
    const namedNodes = nodesByName.get(node.name) ?? [];
    namedNodes.push(node);
    nodesByName.set(node.name, namedNodes);
    node.events?.sort((left, right) => compareText(left.event, right.event) || compareText(left.matcher, right.matcher));
  }
  for (const collisions of nodesByInitialId.values()) {
    if (collisions.length < 2) continue;
    for (const node of collisions) node.id += `:${node.profile}`;
  }
  nodes.sort((left, right) => compareText(left.id, right.id));
  const edgesById = new Map<string, GraphEdge>();
  function addEdge(from: GraphNode, to: GraphNode, kind: EdgeKind): void {
    if (from.id === to.id) return;
    const edge = { from: from.id, to: to.id, kind };
    edgesById.set(`${edge.from}\n${edge.to}\n${edge.kind}`, edge);
  }
  for (const node of nodes) {
    for (const tokens of markdownByNode.get(node) ?? []) {
      for (const name of tokens.names) {
        for (const target of nodesByName.get(name) ?? []) {
          if (target.kind === 'skill') addEdge(node, target, 'mentions');
          if (target.kind === 'agent') addEdge(node, target, 'spawns');
        }
      }
      for (const [names, kind, targetKind] of [[tokens.workflows, 'runs', 'workflow'], [tokens.agents, 'spawns', 'agent']] as const) {
        for (const name of names) {
          for (const target of nodesByName.get(name) ?? []) {
            if (target.kind === targetKind) addEdge(node, target, kind);
          }
        }
      }
    }
    if (node.kind === 'skill') {
      for (let separator = node.name.indexOf('-'); separator >= 0; separator = node.name.indexOf('-', separator + 1)) {
        const baseName = node.name.slice(0, separator);
        for (const base of nodesByName.get(baseName) ?? []) {
          if (base.kind === 'skill' && prefixesByNode.get(base)!.has(`${baseName}-`)) addEdge(base, node, 'extends');
        }
      }
    }
    const sourceTokens = sourceByNode.get(node);
    if (!sourceTokens) continue;
    const sourceNames = node.kind === 'workflow' ? sourceTokens.agents : sourceTokens.literals;
    for (const name of sourceNames) {
      for (const target of nodesByName.get(name) ?? []) {
        if (node.kind === 'hook') addEdge(node, target, 'names');
        if (node.kind === 'workflow' && target.kind === 'agent') addEdge(node, target, 'spawns');
      }
    }
  }
  const edges = [...edgesById.entries()].sort(([left], [right]) => compareText(left, right)).map(([, edge]) => edge);
  const connectedIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return { nodes, edges, isolated: nodes.filter((node) => !connectedIds.has(node.id)).map((node) => node.id), cycles: findCycles(nodes, edges) };
}
