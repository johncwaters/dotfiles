import { parentPort, workerData } from 'node:worker_threads';
import { scanFile } from './census.ts';
import type { ScanWorkerReply } from './census.ts';
import { productNamePatternFor } from './findings.ts';
import type { ScanContext } from './findings.ts';

const { repoDirectory, productNames } = workerData as { repoDirectory: string; productNames: string[] };
const productNamePattern = productNamePatternFor(productNames);

parentPort?.on('message', async (file: string) => {
  const context: ScanContext = { tailwindTextNames: new Set(), deferredTailwindText: [], ...(productNamePattern ? { productNamePattern } : {}) };
  const findings = await scanFile(repoDirectory, file, context);
  const reply: ScanWorkerReply = { findings, tailwindTextNames: [...context.tailwindTextNames], deferredTailwindText: context.deferredTailwindText };
  parentPort?.postMessage(reply);
});
