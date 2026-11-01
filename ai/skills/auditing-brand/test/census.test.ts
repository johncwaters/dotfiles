import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBible } from '../bible/load.ts';

const fixtureRepository = fileURLToPath(new URL('./fixture-repo/', import.meta.url));
const fixtureBible = path.join(fixtureRepository, 'brand-bible');

async function copyFixtureBible(context: test.TestContext): Promise<string> {
  const scratchDirectory = await mkdtemp(path.join(os.tmpdir(), 'auditing-brand-'));
  context.after(() => rm(scratchDirectory, { recursive: true, force: true }));
  const bibleCopy = path.join(scratchDirectory, 'brand-bible');
  await cp(fixtureBible, bibleCopy, { recursive: true });
  return bibleCopy;
}

test('the fixture bible loads, and a missing section, an unknown token and a failing contrast pair are refused by field path', async (context) => {
  const validLoad = await loadBible(fixtureBible);
  assert.equal(validLoad.ok, true);

  const brokenBible = await copyFixtureBible(context);
  await rm(path.join(brokenBible, 'motion.yaml'));
  const colorFile = path.join(brokenBible, 'color.yaml');
  const colorText = await readFile(colorFile, 'utf8');
  await writeFile(colorFile, colorText.replace('foreground: text', 'foreground: missing-token'));
  const missingSectionLoad = await loadBible(brokenBible);
  assert.deepEqual(missingSectionLoad, { ok: false, issues: [{ path: 'motion', message: 'missing motion.yaml' }] });

  await cp(path.join(fixtureBible, 'motion.yaml'), path.join(brokenBible, 'motion.yaml'));
  const unknownTokenLoad = await loadBible(brokenBible);
  assert.deepEqual(unknownTokenLoad, { ok: false, issues: [{ path: 'color.pairs.0.foreground', message: 'names no color token: missing-token' }] });

  await writeFile(colorFile, colorText.replace('value: "#e8e8f0"', 'value: "#16161f"'));
  const lowContrastLoad = await loadBible(brokenBible);
  assert.equal(lowContrastLoad.ok, false);
  assert.match(JSON.stringify(lowContrastLoad), /"path":"color\.pairs\.0","message":"contrast 1\.\d+ is below 4\.5"/);
});
