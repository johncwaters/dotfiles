import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type ArchiveReport =
  | { outcome: "ARCHIVED"; specPath: string; intentPath: string | null }
  | { outcome: "REFUSED"; errors: string[] };

export function archiveSpec(specArgument: string | undefined, outcome: string | undefined, now = new Date()): ArchiveReport {
  const errors: string[] = [];
  if (!specArgument?.endsWith(".json") || specArgument.endsWith(".intent.json")) {
    errors.push("spec path must end in .json and must not end in .intent.json");
  }
  if (outcome !== "built" && outcome !== "abandoned") errors.push("outcome must be built or abandoned");
  if (errors.length > 0) return { outcome: "REFUSED", errors };

  try {
    const specPath = path.resolve(specArgument!);
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    if (typeof spec !== "object" || spec === null || typeof spec.repoRoot !== "string") {
      return { outcome: "REFUSED", errors: ["spec must contain a repoRoot string"] };
    }
    if (fs.existsSync(spec.repoRoot)) {
      const gitDirectory = spawnSync("git", ["-C", spec.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
      if (gitDirectory.status === 0) spec.repoRoot = path.dirname(gitDirectory.stdout.trim());
    }

    const repo = path.basename(path.dirname(specPath));
    const slug = path.basename(specPath, ".json");
    const intentPath = path.join(path.dirname(specPath), `${slug}.intent.json`);
    const intentBytes = fs.existsSync(intentPath) ? fs.readFileSync(intentPath) : null;
    const archiveDirectory = path.join(os.homedir(), ".claude", "spec-archive", repo);
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fs.mkdirSync(archiveDirectory, { recursive: true });

    for (let sequence = 1; ; sequence += 1) {
      const suffix = sequence === 1 ? "" : `.${sequence}`;
      const archiveStem = `${slug}.${outcome}.${localDate}${suffix}`;
      const archivedSpecPath = path.join(archiveDirectory, `${archiveStem}.json`);
      const archivedIntentPath = path.join(archiveDirectory, `${archiveStem}.intent.json`);
      if (fs.existsSync(archivedSpecPath) || fs.existsSync(archivedIntentPath)) continue;

      let hasWrittenSpec = false;
      try {
        fs.writeFileSync(archivedSpecPath, `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx" });
        hasWrittenSpec = true;
        if (intentBytes !== null) fs.writeFileSync(archivedIntentPath, intentBytes, { flag: "wx" });
      } catch (error) {
        if (hasWrittenSpec) fs.unlinkSync(archivedSpecPath);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }

      fs.unlinkSync(specPath);
      if (intentBytes !== null) fs.unlinkSync(intentPath);
      return { outcome: "ARCHIVED", specPath: archivedSpecPath, intentPath: intentBytes === null ? null : archivedIntentPath };
    }
  } catch (error) {
    return { outcome: "REFUSED", errors: [error instanceof Error ? error.message : String(error)] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const report = archiveSpec(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.outcome === "ARCHIVED" ? 0 : 1;
}
