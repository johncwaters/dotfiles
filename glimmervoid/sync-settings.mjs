import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const syncedKeys = new Set([
  'autoRecoverSeconds', 'inputGraceSeconds', 'promptDetectionMs', 'notifyDebounceMs',
  'phoneEscalationMs', 'replayBufferKB', 'cursorBlink', 'debugMode', 'calmLayout',
  'detectBackgroundAgents', 'detectScheduledWakeups', 'recordSignals', 'antiSlopPrompt',
  'rtk', 'saneYolo', 'skipPermissionsByDefault', 'checkForUpdates', 'updateChannel',
  'autoResume', 'telegramNotifications', 'integrationBranch', 'worktreeRoot',
  'worktreeShare', 'worktreeAutoRebase', 'worktreeSyncOnStart', 'worktreeRerere',
  'repoRoots', 'changeMap', 'taskTitle', 'branchGc', 'postTurnChecks', 'visions',
  'teamReview', 'benchmarks', 'factory', 'posthog', 'usage', 'telegram', 'ingest',
  'agentApi', 'telemetry', 'workflows', 'trace', 'planReview', 'customAgents',
  'hooks', 'projects', 'millEnabled', 'scrollback', 'teams',
]);
const projectKeys = new Set(['id', 'name', 'customTitle', 'path', 'repos', 'agent', 'codexBypassHookTrust', 'dangerouslySkipPermissions']);
const secretName = /token|secret|apikey|api_key|password/i;
const runtimeName = /^(sessions?|sessionRecords|wasActive|resumeSessionId|pid|lastStartedAt|lastStoppedAt)$/i;
export const provisionerManagedProjectId = 'bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7';
const stagedHashKey = 'stagedAgainstSettingsSha256';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasIds = value => Array.isArray(value) && value.every(entry => isObject(entry) && typeof entry.id === 'string');

export function withoutProvisionerUpdateDefault(config, ledger) {
  if (ledger.checkForUpdatesMigration || ledger.keys?.includes('checkForUpdates') || config.checkForUpdates !== false) return config;
  const migrated = { ...config };
  delete migrated.checkForUpdates;
  return migrated;
}

function filterValue(value) {
  if (Array.isArray(value)) return value.map(filterValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretName.test(key) && !runtimeName.test(key))
    .map(([key, entry]) => [key, filterValue(entry)]));
}

export function settingsFrom(config) {
  const settings = {};
  for (const [key, value] of Object.entries(config)) {
    if (!syncedKeys.has(key) || secretName.test(key)) continue;
    if (key === 'projects' && Array.isArray(value)) {
      settings[key] = value.map(project => filterValue(Object.fromEntries(Object.entries(project)
        .filter(([field]) => projectKeys.has(field)))));
      continue;
    }
    settings[key] = filterValue(value);
  }
  return settings;
}

export function translateHome(value, home, direction) {
  if (Array.isArray(value)) return value.map(entry => translateHome(entry, home, direction));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translateHome(entry, home, direction)]));
  if (typeof value !== 'string') return value;
  if (direction === 'render') return value.replaceAll('{{HOME}}', home);
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${escapedHome}(?=/|$|["'\\s])`, 'g'), '{{HOME}}');
}

function mergeValue(live, wanted, base, key, mode, warn, exists) {
  if ([live, wanted, base].every(value => value === undefined || hasIds(value)) && [live, wanted, base].some(Array.isArray)) {
    const liveById = new Map((live ?? []).map(entry => [entry.id, entry]));
    const wantedById = new Map((wanted ?? []).map(entry => [entry.id, entry]));
    const baseById = new Map((base ?? []).map(entry => [entry.id, entry]));
    const merged = [];
    for (const id of new Set([...liveById.keys(), ...wantedById.keys(), ...baseById.keys()])) {
      const entry = mergeValue(liveById.get(id), wantedById.get(id), baseById.get(id), `${key}.${id}`, mode, warn, exists);
      if (entry !== undefined) merged.push(entry);
    }
    return merged;
  }
  const hasUnavailableProject = mode === 'apply' && key.startsWith('projects.') && wanted?.path && !exists(wanted.path);
  if (mode === 'collect' && key.startsWith('projects.') && live === undefined && wanted?.path && !exists(wanted.path)) return wanted;
  if (base === undefined) {
    if (hasUnavailableProject) return live;
    if (mode === 'collect') return wanted ?? live;
    return live ?? wanted;
  }
  if (isDeepStrictEqual(live, wanted)) return live;
  const hasLiveChange = !isDeepStrictEqual(live, base);
  const hasFileChange = !isDeepStrictEqual(wanted, base);
  if (hasLiveChange && hasFileChange) warn(key);
  if (hasUnavailableProject) return live;
  if (hasLiveChange) return live;
  return wanted;
}

export function mergeSettings({ live, wanted, base, mode = 'apply', warn = key => console.log(`[warned] glimmervoid settings: conflict ${key}; keeping live`), exists = fs.existsSync }) {
  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(wanted), ...Object.keys(live)])) {
    const value = mergeValue(live[key], wanted[key], base[key], key, mode, warn, exists);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function preserveExcluded(live, synced, key = '') {
  if (hasIds(synced) && Array.isArray(live)) {
    return synced.map(entry => preserveExcluded(live.find(previous => previous?.id === entry.id), entry, key === 'projects' ? 'project' : key));
  }
  if (!isObject(live)) return synced;
  if (synced !== undefined && !isObject(synced)) {
    if (!isDeepStrictEqual(live, filterValue(live))) {
      console.log(`[warned] glimmervoid settings: ${key} contains excluded fields; keeping live`);
      return live;
    }
    return synced;
  }
  const restored = { ...synced };
  for (const [field, value] of Object.entries(live)) {
    if (secretName.test(field) || runtimeName.test(field) || (key === 'project' && !projectKeys.has(field))) {
      restored[field] = value;
      continue;
    }
    const protectedValue = preserveExcluded(value, synced?.[field], field);
    if (protectedValue !== undefined) restored[field] = protectedValue;
  }
  if (synced === undefined && Object.keys(restored).length === 0) return undefined;
  return restored;
}

export function readJson(filePath, fallback = {}) {
  let fileStatus;
  try {
    fileStatus = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
  if (!fileStatus.isFile()) throw new Error(`${filePath} must be a regular file`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isObject(parsed)) throw new Error(`${filePath} must contain an object`);
  return parsed;
}

export function writeJson(filePath, value, originalBytes) {
  readJson(filePath);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath) && isDeepStrictEqual(readJson(filePath), value)) {
    fs.chmodSync(filePath, 0o600);
    return false;
  }
  const suffix = crypto.randomUUID();
  const stagedPath = path.join(path.dirname(filePath), `.settings-${suffix}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(stagedPath, serialized, { mode: 0o600, flag: 'wx' });
    if (originalBytes !== undefined) {
      if (fs.readFileSync(filePath, 'utf8') !== originalBytes) throw new Error('config changed during sync; rerun');
      fs.writeFileSync(`${filePath}.${suffix}.bak`, originalBytes, { mode: 0o600, flag: 'wx' });
    }
    fs.renameSync(stagedPath, filePath);
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
  return true;
}

export function planApply(config, wanted, base) {
  const live = settingsFrom(config);
  const merged = mergeSettings({ live, wanted: settingsFrom(wanted), base: settingsFrom(base) });
  const nextConfig = { ...config };
  for (const key of new Set([...Object.keys(live), ...Object.keys(merged)])) {
    if (!Object.hasOwn(merged, key)) {
      delete nextConfig[key];
      const protectedValue = preserveExcluded(config[key], undefined, key);
      if (protectedValue !== undefined) nextConfig[key] = protectedValue;
      continue;
    }
    nextConfig[key] = preserveExcluded(config[key], merged[key], key);
  }
  const nextBase = settingsFrom(base);
  for (const key of new Set([...Object.keys(wanted), ...Object.keys(base)])) {
    if (!syncedKeys.has(key)) continue;
    const advanced = advanceBase(merged[key], wanted[key], base[key]);
    delete nextBase[key];
    if (advanced !== undefined) nextBase[key] = advanced;
  }
  return { config: nextConfig, base: settingsFrom(nextBase) };
}

function advanceBase(merged, wanted, base) {
  if (hasIds(merged) && [wanted, base].every(value => value === undefined || hasIds(value))) {
    const mergedById = new Map(merged.map(entry => [entry.id, entry]));
    const wantedById = new Map((wanted ?? []).map(entry => [entry.id, entry]));
    const baseById = new Map((base ?? []).map(entry => [entry.id, entry]));
    return [...new Set([...wantedById.keys(), ...baseById.keys()])]
      .map(id => advanceBase(mergedById.get(id), wantedById.get(id), baseById.get(id)))
      .filter(entry => entry !== undefined);
  }
  if (merged === undefined && base === undefined) return undefined;
  if (isDeepStrictEqual(merged, wanted) || base === undefined) return wanted;
  return base;
}

const sha256Of = fileBytes => crypto.createHash('sha256').update(fileBytes).digest('hex');

export function settingsFileHash(filePath) {
  readJson(filePath);
  return sha256Of(fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0));
}

function readStagedChanges(stagedPath) {
  if (readJson(stagedPath, undefined) === undefined) return undefined;
  const stagedBytes = fs.readFileSync(stagedPath);
  const settings = JSON.parse(stagedBytes.toString('utf8'));
  if (!isObject(settings)) throw new Error(`${stagedPath} must contain an object`);
  return { settings, sha256: sha256Of(stagedBytes) };
}

export function withRepoRootsAsWanted(live, wanted) {
  const liveWithoutRepoRoots = { ...live };
  delete liveWithoutRepoRoots.repoRoots;
  if (wanted.repoRoots === undefined) return liveWithoutRepoRoots;
  return { ...liveWithoutRepoRoots, repoRoots: wanted.repoRoots };
}

export function withManagedProjectAsWanted(live, wanted) {
  if (!Array.isArray(live.projects)) return live;
  const wantedManagedProject = (wanted.projects ?? []).find(project => project?.id === provisionerManagedProjectId);
  const projects = live.projects
    .map(project => project?.id === provisionerManagedProjectId ? wantedManagedProject : project)
    .filter(project => project !== undefined);
  if (projects.length === 0 && wanted.projects === undefined) {
    const liveWithoutProjects = { ...live };
    delete liveWithoutProjects.projects;
    return liveWithoutProjects;
  }
  return { ...live, projects };
}

export function portListens(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = isListening => { socket.destroy(); resolve(isListening); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function runCommand() {
  const [command, configPath, settingsPath, basePath, home = process.env.HOME] = process.argv.slice(2);
  if (command === 'collect-remote') {
    const stagedPath = configPath;
    const packet = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!isObject(packet) || typeof packet.home !== 'string' || !isObject(packet.live) || !isObject(packet.base) || !Array.isArray(packet.projectPaths)) throw new Error('box settings packet is malformed');
    const committed = readJson(settingsPath);
    const wanted = translateHome(settingsFrom(committed), packet.home, 'render');
    const merged = mergeSettings({ live: withRepoRootsAsWanted(withManagedProjectAsWanted(settingsFrom(packet.live), wanted), wanted), wanted, base: settingsFrom(packet.base), mode: 'collect', exists: projectPath => packet.projectPaths.includes(projectPath) });
    const collected = translateHome(merged, packet.home, 'tokenize');
    if (isDeepStrictEqual(collected, settingsFrom(committed))) {
      readJson(stagedPath);
      fs.rmSync(stagedPath, { force: true });
      return;
    }
    writeJson(stagedPath, { ...collected, [stagedHashKey]: settingsFileHash(settingsPath) });
    console.log('[warned] glimmervoid settings: box changes staged; review with devbox collect --diff, accept with devbox collect --accept <hash>');
    return;
  }
  if (command === 'staged-hash') {
    const stagedPath = configPath;
    const stagedChanges = readStagedChanges(stagedPath);
    if (stagedChanges === undefined) throw new Error('no staged box changes to hash');
    console.log(`staged: ${stagedChanges.sha256}`);
    return;
  }
  if (command === 'accept') {
    const stagedPath = configPath;
    const reviewedStagedHash = basePath;
    const stagedChanges = readStagedChanges(stagedPath);
    if (stagedChanges === undefined) throw new Error('no staged box changes to accept');
    if (!reviewedStagedHash) {
      console.log('[warned] glimmervoid settings: pass the staged hash from devbox collect --diff, as devbox collect --accept <hash>');
      process.exitCode = 1;
      return;
    }
    if (reviewedStagedHash !== stagedChanges.sha256) {
      console.log('[warned] glimmervoid settings: staged box changes differ from the reviewed hash; review again with devbox collect --diff');
      process.exitCode = 1;
      return;
    }
    const staged = stagedChanges.settings;
    if (staged[stagedHashKey] !== settingsFileHash(settingsPath)) {
      console.log(`[warned] glimmervoid settings: ${settingsPath} changed since box changes were staged; rerun devbox collect`);
      process.exitCode = 1;
      return;
    }
    writeJson(settingsPath, settingsFrom(staged));
    fs.rmSync(stagedPath);
    console.log(`[applied] glimmervoid settings: accepted box changes into ${settingsPath}; commit them`);
    return;
  }
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
  const config = readJson(configPath);
  const wanted = translateHome(settingsFrom(readJson(settingsPath)), home, 'render');
  const base = settingsFrom(readJson(basePath));
  if (command === 'collect') {
    const merged = mergeSettings({ live: settingsFrom(config), wanted, base, mode: 'collect' });
    writeJson(settingsPath, translateHome(merged, home, 'tokenize'));
    writeJson(basePath, settingsFrom(config));
    return;
  }
  if (command !== 'apply') throw new Error('expected apply, collect, collect-remote, staged-hash or accept');
  const planned = planApply(config, wanted, base);
  if (!isDeepStrictEqual(config, planned.config) && await portListens(config.port ?? 3000)) {
    console.log('[warned] glimmervoid settings: changes pending; stop glimmervoid and rerun dot');
    return;
  }
  writeJson(configPath, planned.config, original);
  writeJson(basePath, planned.base);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await runCommand();
