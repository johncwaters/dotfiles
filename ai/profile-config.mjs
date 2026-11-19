import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const profilesDirectory = fileURLToPath(new URL("../profiles/", import.meta.url));

export function readProfilePolicies() {
  return fs.readdirSync(profilesDirectory).flatMap((profileName) => {
    const policyPath = path.join(profilesDirectory, profileName, "ai.json");
    if (!fs.existsSync(policyPath)) return [];
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    return [{ ...policy, profileName }];
  });
}

export function profileLineage(profileName, ancestors = []) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileName)) throw new Error(`invalid profile name: ${profileName}`);
  if (ancestors.includes(profileName)) throw new Error(`cyclic AI inheritance: ${[...ancestors, profileName].join(" -> ")}`);
  const profileDirectory = path.join(profilesDirectory, profileName);
  if (!fs.statSync(profileDirectory).isDirectory()) throw new Error(`missing profile: ${profileName}`);
  const policy = readProfilePolicies().find((candidate) => candidate.profileName === profileName) ?? {};
  if (policy.extends === undefined) return [profileName];
  return [...profileLineage(policy.extends, [...ancestors, profileName]), profileName];
}

export function profileSource(profileName, relativePath) {
  for (const sourceProfile of profileLineage(profileName).reverse()) {
    const sourcePath = path.join(profilesDirectory, sourceProfile, relativePath);
    if (fs.existsSync(sourcePath)) return sourcePath;
  }
  return "";
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileName = process.argv[2];
  if (process.argv[3]) {
    process.stdout.write(profileSource(profileName, process.argv[3]));
    process.exit(0);
  }
  const plan = [];
  for (const sourceProfile of profileLineage(profileName)) plan.push(["include-profile", sourceProfile]);
  for (const relativePath of ["AGENTS.md", "review-checklist.md", "owned-repos.txt", "hooks", "settings.overlay.json", "codex-hooks.json", "mcp-servers.json"]) {
    const sourcePath = profileSource(profileName, relativePath);
    if (sourcePath) plan.push([`source-${relativePath}`, path.relative(fileURLToPath(new URL("../", import.meta.url)), sourcePath)]);
  }
  process.stdout.write(plan.map((entry) => entry.join("\t")).join("\n"));
}
