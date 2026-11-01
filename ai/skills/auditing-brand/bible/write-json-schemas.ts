import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SECTION_NAMES, SECTION_SCHEMAS } from './schema.ts';

export async function writeSectionJsonSchemas(outputDirectory: string): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  return Promise.all(SECTION_NAMES.map(async (sectionName) => {
    const schemaFile = path.join(outputDirectory, `${sectionName}.schema.json`);
    await writeFile(schemaFile, `${JSON.stringify(z.toJSONSchema(SECTION_SCHEMAS[sectionName]), null, 2)}\n`);
    return schemaFile;
  }));
}

async function main(commandArguments: string[]): Promise<void> {
  const outputDirectory = commandArguments[0];
  if (!outputDirectory) {
    process.stderr.write('usage: node write-json-schemas.ts <output directory>\n');
    process.exitCode = 2;
    return;
  }
  const writtenFiles = await writeSectionJsonSchemas(path.resolve(outputDirectory));
  process.stdout.write(`${writtenFiles.join('\n')}\n`);
}

if (import.meta.main) await main(process.argv.slice(2));
