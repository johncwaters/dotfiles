import { defaultProjectsDir, digestTranscript, findTranscript, listTranscriptsSince } from "./lib/digest.ts";

type DigestArguments = { target?: string; since?: string; projectsDir: string; includeGit: boolean };

function parseArguments(argumentsList: string[]): DigestArguments {
  const options: DigestArguments = { projectsDir: defaultProjectsDir(), includeGit: true };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index] ?? "";
    if (argument === "--no-git") {
      options.includeGit = false;
      continue;
    }
    if (argument === "--since" || argument === "--projects-dir") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      index += 1;
      if (argument === "--since") options.since = value;
      if (argument === "--projects-dir") options.projectsDir = value;
      continue;
    }
    if (!argument || argument.startsWith("-") || options.target) throw new Error(`Unexpected argument: ${argument}`);
    options.target = argument;
  }
  if (Boolean(options.target) === Boolean(options.since)) throw new Error("Provide one session id, transcript path, or --since date");
  if (options.since && !Number.isFinite(Date.parse(options.since))) {
    throw new Error("Invalid --since date; expected YYYY-MM-DD or ISO timestamp");
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.since) {
    const digests = [];
    for (const transcriptPath of listTranscriptsSince(options.projectsDir, options.since)) {
      digests.push(await digestTranscript(transcriptPath, options));
    }
    process.stdout.write(`${JSON.stringify(digests)}\n`);
  }
  if (options.target) {
    const transcriptPath = findTranscript(options.target, options.projectsDir);
    if (!transcriptPath) throw new Error(`Transcript not found: ${options.target}`);
    process.stdout.write(`${JSON.stringify(await digestTranscript(transcriptPath, options))}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
