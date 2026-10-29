import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import exampleBoard from '../examples/webhook-to-email.ts';
import { layOut } from '../render.ts';

const executeFile = promisify(execFile);
const rendererPath = fileURLToPath(new URL('../render.ts', import.meta.url));
const examplePath = fileURLToPath(new URL('../examples/webhook-to-email.ts', import.meta.url));

test('renders the example board to a page, and refuses a copy with an overlapping box and an unknown arrow target', async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'whiteboard-'));
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const outputPath = path.join(outputDirectory, 'index.html');
  await executeFile(process.execPath, [rendererPath, examplePath, outputPath]);
  assert.match(await readFile(outputPath, 'utf8'), /<svg viewBox="0 0 1300 770"/);

  const brokenBoard = structuredClone(exampleBoard);
  brokenBoard.boxes.push({ id: 'stray', column: 'steps', y: 150, title: 'a box dropped on step 1' });
  brokenBoard.edges.push({ from: 'inbox', to: 'nowhere' });
  assert.deepEqual(layOut(brokenBoard).problems, ['inbox->nowhere: unknown box "nowhere"']);
  brokenBoard.edges.pop();
  assert.ok(layOut(brokenBoard).problems.includes('boxes overlap: log_request and stray'));
});
