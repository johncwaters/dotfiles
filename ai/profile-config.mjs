import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const profilesDirectory = fileURLToPath(new URL("../profiles/", import.meta.url));

export function readProfilePolicies() {
  return fs.readdirSync(profilesDirectory).flatMap((profileName) => {
    const policyPath = path.join(profilesDirectory, profileName, "ai.json");
    if (!fs.existsSync(policyPath)) return [];
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    for (const skillName of policy.exclusiveSkills ?? []) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) throw new Error(`invalid skill name: ${skillName}`);
    }
    for (const serverName of Object.keys(policy.mcpServers ?? {})) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(serverName)) throw new Error(`invalid server name: ${serverName}`);
    }
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

export function profilePolicy(profileName) {
  const policies = readProfilePolicies();
  const lineage = profileLineage(profileName);
  const activePolicies = lineage.map((sourceProfile) => policies.find((policy) => policy.profileName === sourceProfile) ?? {});
  const activePolicy = {
    exclusiveSkills: [...new Set(activePolicies.flatMap((policy) => policy.exclusiveSkills ?? []))],
    mcpServers: Object.assign({}, ...activePolicies.map((policy) => policy.mcpServers ?? {})),
  };
  const removedPolicies = policies.filter((policy) => !lineage.includes(policy.profileName));
  return {
    ...activePolicy,
    removedSkills: [...new Set(removedPolicies.flatMap((policy) => policy.exclusiveSkills ?? []))]
      .filter((skillName) => !activePolicy.exclusiveSkills.includes(skillName)),
    removedServers: [...new Set(removedPolicies.flatMap((policy) => Object.entries(policy.mcpServers ?? {})
      .filter(([, serverPolicy]) => serverPolicy.exclusive).map(([serverName]) => serverName)))]
      .filter((serverName) => !activePolicy.mcpServers[serverName]),
  };
}

export function confiningHookScriptName(serverName) {
  return `confine-${serverName}.mjs`;
}

function matcherCoversTool(matcher, toolName) {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(toolName);
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

export function wiresConfiningHook(hooksByEvent, confiningScriptPath, serverName) {
  const serverToolName = `mcp__${serverName}__probe`;
  const preToolUseEntries = Array.isArray(hooksByEvent?.PreToolUse) ? hooksByEvent.PreToolUse : [];
  return preToolUseEntries.some((entry) =>
    matcherCoversTool(entry?.matcher, serverToolName)
    && Array.isArray(entry?.hooks)
    && entry.hooks.some((handler) => String(handler?.command ?? "").split(/[\s"']+/).includes(confiningScriptPath)));
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileName = process.argv[2];
  if (process.argv[3]) {
    process.stdout.write(profileSource(profileName, process.argv[3]));
    process.exit(0);
  }
  const activePolicy = profilePolicy(profileName);
  const declarationPath = profileSource(profileName, "mcp-servers.json");
  const declaredServers = declarationPath ? JSON.parse(fs.readFileSync(declarationPath, "utf8")) : {};
  const plan = [];
  for (const sourceProfile of profileLineage(profileName)) plan.push(["include-profile", sourceProfile]);
  for (const relativePath of ["CLAUDE.md", "AGENTS.md", "review-checklist.md", "hooks", "settings.overlay.json", "codex-hooks.json", "mcp-servers.json"]) {
    const sourcePath = profileSource(profileName, relativePath);
    if (sourcePath) plan.push([`source-${relativePath}`, path.relative(fileURLToPath(new URL("../", import.meta.url)), sourcePath)]);
  }
  for (const skillName of activePolicy.removedSkills) plan.push(["remove-skill", skillName]);
  for (const serverName of activePolicy.removedServers) plan.push(["remove-server", serverName]);
  for (const [serverName, serverPolicy] of Object.entries(activePolicy.mcpServers ?? {})) {
    if (!Object.hasOwn(declaredServers, serverName)) {
      if (serverPolicy.exclusive) plan.push(["remove-server", serverName]);
      continue;
    }
    if (serverPolicy.confined) plan.push(["confine-server", serverName]);
    if (serverPolicy.codex) plan.push(["codex-server", serverName]);
    if (serverPolicy.exclusive) plan.push(["exclusive-server", serverName]);
  }
  process.stdout.write(plan.map((entry) => entry.join("\t")).join("\n"));
}
