import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareText, findCycles } from '../../lib/graph-page.mts';

export type NodeKind = 'profile' | 'topic' | 'lib' | 'profileFile' | 'packageGroup' | 'shellFragment' | 'target';
export type EdgeKind = 'runs' | 'extends' | 'sources' | 'links' | 'copies' | 'stubs' | 'renders' | 'reads' | 'installs' | 'loads';
export type GraphNode = { id: string; name: string; kind: NodeKind; column: number; path: string; files: string[]; lines: string[] };
export type GraphEdge = { from: string; to: string; kind: EdgeKind; order?: number };
export type DotfilesGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  signals: { unrunTopics: string[]; unsourcedLibs: string[]; unreferencedFiles: string[]; sourceCycles: string[][] };
};

type PlacementCall = { kind: EdgeKind; sourceWordIndex?: number; destinationWordIndex: number };
const placementCallByHelper: Record<string, PlacementCall> = {
  linkEntry: { kind: 'links', sourceWordIndex: 2, destinationWordIndex: 3 },
  copyEntry: { kind: 'copies', sourceWordIndex: 2, destinationWordIndex: 3 },
  ensureStubFile: { kind: 'stubs', destinationWordIndex: 2 },
  renderJsonTemplate: { kind: 'renders', sourceWordIndex: 3, destinationWordIndex: 5 },
};
const topicEntryFileNames = new Set(['install.sh', 'collect.sh', 'test.sh']);
const scriptExtensions = new Set(['.sh', '.bash', '.mjs', '.js', '.ts', '.mts']);
const skippedDirectoryNames = new Set(['.git', 'node_modules', 'test']);

function readSortedEntries(directory: string): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
}

function listTrackedPaths(repoRoot: string): { trackedFiles: string[]; trackedPaths: Set<string> } {
  const trackedFiles = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const trackedPaths = new Set(trackedFiles.flatMap((trackedFile) => trackedFile.split('/').map((_, depth, segments) => segments.slice(0, depth + 1).join('/'))));
  return { trackedFiles, trackedPaths };
}

function isTextFile(filePath: string): boolean {
  if (!fs.statSync(filePath).isFile()) return false;
  return !fs.readFileSync(filePath).subarray(0, 8000).includes(0);
}

function isScript(filePath: string): boolean {
  if (scriptExtensions.has(path.extname(filePath))) return true;
  return isTextFile(filePath) && fs.readFileSync(filePath, 'utf8').startsWith('#!');
}

function joinContinuedLines(source: string): string[] {
  return source.replace(/\\\n\s*/g, ' ').split('\n');
}

function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let parenDepth = 0;
  let hasWord = false;
  for (const character of line) {
    if (quote) {
      if (character === quote && parenDepth === 0) {
        quote = '';
        continue;
      }
      word += character;
      if (character === '(') parenDepth++;
      if (character === ')') parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      hasWord = true;
      continue;
    }
    if (/\s/.test(character) && parenDepth === 0) {
      if (hasWord) words.push(word);
      word = '';
      hasWord = false;
      continue;
    }
    if (character === '(') parenDepth++;
    if (character === ')') parenDepth = Math.max(0, parenDepth - 1);
    word += character;
    hasWord = true;
  }
  if (hasWord) words.push(word);
  return words;
}

function readLiteralAssignments(source: string): Map<string, string> {
  const valuesByName = new Map<string, Set<string>>();
  for (const match of source.matchAll(/^\s*(?:local\s+|readonly\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)="((?:[^"$`\\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)*)"\s*$/gm)) {
    const values = valuesByName.get(match[1]!) ?? new Set<string>();
    values.add(match[2]!);
    valuesByName.set(match[1]!, values);
  }
  return new Map([...valuesByName].filter(([, values]) => values.size === 1).map(([name, values]) => [name, [...values][0]!]));
}

function substituteLiterals(text: string, literalByName: Map<string, string>): string {
  let substituted = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = substituted.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (reference, name: string) => literalByName.get(name) ?? reference);
    if (next === substituted) break;
    substituted = next;
  }
  return substituted.replace(/^(\$\{?HOME\}?)(?=\/|$)/, '~');
}

function resolveSourcedPath(word: string, fileDirectory: string, repoRoot: string): string | undefined {
  const scriptDirectoryForm = word.match(/^\$\(cd -- "?\$\(dirname -- "?\$\{BASH_SOURCE\[0\]\}"?\)(\/[^"]*)?"? && pwd\)(\/.+)$/);
  if (scriptDirectoryForm) return path.join(fileDirectory, scriptDirectoryForm[1] ?? '', scriptDirectoryForm[2]!);
  const variableForm = word.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/.+)$/);
  if (!variableForm) return undefined;
  const isRepoRoot = variableForm[1] === 'dotfilesRepo' || variableForm[1] === 'DOTFILES';
  return path.join(isRepoRoot ? repoRoot : fileDirectory, variableForm[2]!);
}

export function extractDotfilesGraph(repoRoot: string): DotfilesGraph {
  const toRepoPath = (filePath: string) => path.relative(repoRoot, filePath).split(path.sep).join('/');
  const { trackedFiles, trackedPaths } = listTrackedPaths(repoRoot);
  const entries = (directory: string) => readSortedEntries(directory).filter((entry) => trackedPaths.has(toRepoPath(path.join(directory, entry.name))));
  const nodesById = new Map<string, GraphNode>();
  const edgesByKey = new Map<string, GraphEdge>();
  function addNode(node: GraphNode): GraphNode {
    const existing = nodesById.get(node.id);
    if (existing) return existing;
    nodesById.set(node.id, node);
    return node;
  }
  function addEdge(edge: GraphEdge): void {
    if (edge.from === edge.to) return;
    edgesByKey.set(`${edge.from}\n${edge.to}\n${edge.kind}`, edge);
  }
  function textFilesFor(filePath: string): string[] {
    if (fs.statSync(filePath).isDirectory()) return entries(filePath).map((entry) => path.join(filePath, entry.name)).filter(isTextFile).map(toRepoPath);
    return trackedPaths.has(toRepoPath(filePath)) && isTextFile(filePath) ? [toRepoPath(filePath)] : [];
  }

  const topicNames = entries(repoRoot).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, entry.name, 'install.sh'))).map((entry) => entry.name);
  const runOrdersByTopic = new Map<string, string[]>();
  const profileNames = entries(path.join(repoRoot, 'profiles')).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'profiles', entry.name, 'profile.json'))).map((entry) => entry.name);
  for (const profileName of profileNames) {
    const profileDirectory = path.join(repoRoot, 'profiles', profileName);
    const profileSettings = JSON.parse(fs.readFileSync(path.join(profileDirectory, 'profile.json'), 'utf8')) as { platform?: string; topics?: string[] };
    const ownFiles = ['profile.json', 'packages.txt', 'ai.json'].filter((fileName) => fs.existsSync(path.join(profileDirectory, fileName))).map((fileName) => `profiles/${profileName}/${fileName}`);
    addNode({ id: `profile:${profileName}`, name: profileName, kind: 'profile', column: 0, path: `profiles/${profileName}`, files: ownFiles, lines: [profileName, `profile · ${profileSettings.platform ?? 'any platform'}`] });
    (profileSettings.topics ?? []).forEach((topicName, topicIndex) => {
      addEdge({ from: `profile:${profileName}`, to: `topic:${topicName}`, kind: 'runs', order: topicIndex + 1 });
      runOrdersByTopic.set(topicName, [...(runOrdersByTopic.get(topicName) ?? []), `${profileName} #${topicIndex + 1}`]);
    });
    const aiSettingsPath = path.join(profileDirectory, 'ai.json');
    const parentProfile = fs.existsSync(aiSettingsPath) ? (JSON.parse(fs.readFileSync(aiSettingsPath, 'utf8')) as { extends?: string }).extends : undefined;
    if (parentProfile) addEdge({ from: `profile:${profileName}`, to: `profile:${parentProfile}`, kind: 'extends' });
    const packagesPath = path.join(profileDirectory, 'packages.txt');
    const packageGroups = fs.existsSync(packagesPath) ? fs.readFileSync(packagesPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')) : [];
    for (const groupName of packageGroups) {
      const groupListPath = path.join(repoRoot, 'packages', `${groupName}.txt`);
      addNode({ id: `packageGroup:${groupName}`, name: groupName, kind: 'packageGroup', column: 2, path: toRepoPath(fs.existsSync(groupListPath) ? groupListPath : packagesPath), files: textFilesFor(fs.existsSync(groupListPath) ? groupListPath : packagesPath), lines: [groupName, 'package group'] });
      addEdge({ from: `profile:${profileName}`, to: `packageGroup:${groupName}`, kind: 'installs' });
    }
    for (const entry of entries(profileDirectory)) {
      if (['profile.json', 'packages.txt'].includes(entry.name)) continue;
      const entryPath = path.join(profileDirectory, entry.name);
      const files = textFilesFor(entryPath);
      addNode({ id: `profileFile:${profileName}/${entry.name}`, name: `${profileName}/${entry.name}${entry.isDirectory() ? '/' : ''}`, kind: 'profileFile', column: 2, path: toRepoPath(entryPath), files: files.length ? files : ownFiles, lines: [`${profileName}/${entry.name}${entry.isDirectory() ? '/' : ''}`, 'profile file'] });
    }
  }

  const libPaths = new Set(entries(path.join(repoRoot, 'script', 'lib')).filter((entry) => entry.isFile() && entry.name.endsWith('.sh')).map((entry) => `script/lib/${entry.name}`));
  for (const topicName of topicNames) {
    for (const entry of entries(path.join(repoRoot, topicName))) {
      if (entry.isFile() && entry.name.endsWith('.sh') && !topicEntryFileNames.has(entry.name)) libPaths.add(`${topicName}/${entry.name}`);
    }
  }
  for (const libPath of libPaths) addNode({ id: `lib:${libPath}`, name: libPath, kind: 'lib', column: 2, path: libPath, files: [libPath], lines: [libPath, 'lib'] });

  for (const topicName of topicNames) {
    const topicDirectory = path.join(repoRoot, topicName);
    const hasCollector = fs.existsSync(path.join(topicDirectory, 'collect.sh'));
    const runOrders = runOrdersByTopic.get(topicName) ?? [];
    addNode({
      id: `topic:${topicName}`,
      name: topicName,
      kind: 'topic',
      column: 1,
      path: topicName,
      files: [`${topicName}/install.sh`, ...(hasCollector ? [`${topicName}/collect.sh`] : [])],
      lines: [topicName, `topic${hasCollector ? ' · collect.sh' : ''}`, runOrders.length ? runOrders.join(', ') : 'no profile'],
    });
    for (const entry of entries(topicDirectory)) {
      if (!entry.isFile() || !entry.name.endsWith('.bash')) continue;
      const fragmentPath = `${topicName}/${entry.name}`;
      addNode({ id: `shellFragment:${fragmentPath}`, name: fragmentPath, kind: 'shellFragment', column: 2, path: fragmentPath, files: [fragmentPath], lines: [fragmentPath, 'shell fragment'] });
      addEdge({ from: `topic:${topicName}`, to: `shellFragment:${fragmentPath}`, kind: 'loads' });
    }
  }

  const ownerIdForScript = (repoPath: string): string | undefined => {
    if (nodesById.has(`lib:${repoPath}`)) return `lib:${repoPath}`;
    const topicName = repoPath.split('/')[0]!;
    if (!topicNames.includes(topicName) || repoPath.split('/').some((segment) => skippedDirectoryNames.has(segment)) || repoPath.endsWith('/test.sh')) return undefined;
    return `topic:${topicName}`;
  };
  const scriptPaths = trackedFiles.filter((trackedFile) => !trackedFile.split('/').some((segment) => skippedDirectoryNames.has(segment))).map((trackedFile) => path.join(repoRoot, trackedFile)).filter((scriptPath) => fs.existsSync(scriptPath) && isScript(scriptPath));
  const referencedNames = new Set<string>();
  const referencedExtensionsByTopic = new Map<string, Set<string>>();
  const ownedTokensByOwnerId = new Map<string, Set<string>>();
  for (const scriptPath of scriptPaths) {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const repoPath = toRepoPath(scriptPath);
    for (const token of source.match(/[A-Za-z0-9._-]+/g) ?? []) referencedNames.add(token);
    const topicName = repoPath.split('/')[0]!;
    for (const globMatch of source.matchAll(/\*(\.[A-Za-z0-9]+)\b/g)) {
      referencedExtensionsByTopic.set(topicName, (referencedExtensionsByTopic.get(topicName) ?? new Set()).add(globMatch[1]!));
    }
    const ownerId = ownerIdForScript(repoPath);
    if (!ownerId) continue;
    const ownedTokens = ownedTokensByOwnerId.get(ownerId) ?? new Set<string>();
    for (const token of source.match(/[A-Za-z0-9._-]+/g) ?? []) ownedTokens.add(token);
    ownedTokensByOwnerId.set(ownerId, ownedTokens);
    const literalByName = readLiteralAssignments(source);
    for (const line of joinContinuedLines(source)) {
      const words = splitShellWords(line.replace(/^\s+/, ''));
      if (words[0] === 'source' || words[0] === '.') {
        const sourcedPath = words[1] ? resolveSourcedPath(words[1], path.dirname(scriptPath), repoRoot) : undefined;
        if (sourcedPath && nodesById.has(`lib:${toRepoPath(sourcedPath)}`)) addEdge({ from: ownerId, to: `lib:${toRepoPath(sourcedPath)}`, kind: 'sources' });
        continue;
      }
      const placementCall = placementCallByHelper[words[0] ?? ''];
      if (!placementCall || !ownerId.startsWith('topic:')) continue;
      const placementKind = placementCall.kind;
      const destinationWord = words[placementCall.destinationWordIndex];
      const sourceWord = placementCall.sourceWordIndex === undefined ? undefined : words[placementCall.sourceWordIndex];
      if (!destinationWord) continue;
      const destination = substituteLiterals(destinationWord, literalByName);
      const repoSource = sourceWord ? substituteLiterals(sourceWord, literalByName).replace(/^\$\{?dotfilesRepo\}?\//, '') : undefined;
      const repoSourcePath = repoSource ? path.join(repoRoot, repoSource) : undefined;
      const sourceFiles = repoSourcePath && fs.existsSync(repoSourcePath) ? textFilesFor(repoSourcePath) : [];
      addNode({ id: `target:${destination}`, name: destination, kind: 'target', column: 3, path: repoSource ?? repoPath, files: sourceFiles.length ? sourceFiles : [repoPath], lines: [destination, `${placementKind} from ${repoSource ?? `${repoPath} stub`}`] });
      addEdge({ from: ownerId, to: `target:${destination}`, kind: placementKind });
    }
  }

  for (const profileFileNode of [...nodesById.values()].filter((node) => node.kind === 'profileFile')) {
    const fileName = profileFileNode.path.split('/').pop()!;
    for (const [ownerId, ownedTokens] of ownedTokensByOwnerId) {
      if (ownedTokens.has(fileName)) addEdge({ from: ownerId, to: profileFileNode.id, kind: 'reads' });
    }
  }

  const nodes = [...nodesById.values()].sort((left, right) => compareText(left.id, right.id));
  const edges = [...edgesByKey.entries()].sort(([left], [right]) => compareText(left, right)).map(([, edge]) => edge);
  const sourcedIds = new Set(edges.filter((edge) => edge.kind === 'sources').map((edge) => edge.to));
  const ranTopicIds = new Set(edges.filter((edge) => edge.kind === 'runs').map((edge) => edge.to));
  const unreferencedFiles = topicNames.flatMap((topicName) => entries(path.join(repoRoot, topicName))
    .filter((entry) => !topicEntryFileNames.has(entry.name) && !skippedDirectoryNames.has(entry.name) && !entry.name.endsWith('.bash') && !libPaths.has(`${topicName}/${entry.name}`))
    .filter((entry) => !referencedNames.has(entry.name) && !referencedExtensionsByTopic.get(topicName)?.has(path.extname(entry.name)))
    .map((entry) => `${topicName}/${entry.name}`));
  return {
    nodes,
    edges,
    signals: {
      unrunTopics: topicNames.filter((topicName) => !ranTopicIds.has(`topic:${topicName}`)).map((topicName) => `topic:${topicName}`),
      unsourcedLibs: nodes.filter((node) => node.kind === 'lib' && !sourcedIds.has(node.id)).map((node) => node.id),
      unreferencedFiles,
      sourceCycles: findCycles(nodes.map((node) => node.id), edges.filter((edge) => edge.kind === 'sources')),
    },
  };
}
