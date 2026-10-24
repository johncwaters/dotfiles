import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const executeFile = promisify(execFile);
const rendererPath = fileURLToPath(new URL('../render.ts', import.meta.url));

test('renders byte-identical HTML and graph with the open-pr storytelling dependency', async (context) => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), 'skill-tree-first-'));
  context.after(() => rm(firstDirectory, { recursive: true, force: true }));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'skill-tree-second-'));
  context.after(() => rm(secondDirectory, { recursive: true, force: true }));
  for (const outputDirectory of [firstDirectory, secondDirectory]) {
    await executeFile(process.execPath, [rendererPath, outputDirectory], { cwd: os.tmpdir() });
  }
  for (const fileName of ['index.html', 'graph.json']) {
    assert.deepEqual(await readFile(path.join(firstDirectory, fileName)), await readFile(path.join(secondDirectory, fileName)));
  }
  const graph = JSON.parse(await readFile(path.join(firstDirectory, 'graph.json'), 'utf8'));
  assert.ok(graph.edges.some((edge: { from: string; to: string; kind: string }) => edge.from === 'skill:open-pr' && edge.to === 'skill:storytelling' && edge.kind === 'mentions'));
});
