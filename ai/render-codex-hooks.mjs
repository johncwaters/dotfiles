import fs from "node:fs";
import os from "node:os";
import { readProfilePolicies } from "./profile-config.mjs";

const [declarationPath, runtimePath, destinationPath, ownedCommandsPath] = process.argv.slice(2);

function readHookConfiguration(configurationPath) {
  if (!fs.existsSync(configurationPath)) return { hooks: {} };
  const configuration = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error(`invalid hook configuration: ${configurationPath}`);
  }
  if (!configuration.hooks) configuration.hooks = {};
  if (typeof configuration.hooks !== "object" || Array.isArray(configuration.hooks)) {
    throw new Error(`invalid hook events: ${configurationPath}`);
  }
  return configuration;
}

const retiredCommandPatterns = readProfilePolicies().flatMap((policy) =>
  (policy.retiredCodexHookCommands ?? []).map((pattern) => new RegExp(pattern, "i")),
);

let ownedCommands = new Set();

function isOwnedHook(handler) {
  return ownedCommands.has(handler.command) || retiredCommandPatterns.some((pattern) => pattern.test(String(handler.command || "")));
}

try {
  const declaration = readHookConfiguration(new URL("./codex-hooks.base.json", import.meta.url));
  if (fs.realpathSync(declarationPath) !== fs.realpathSync(new URL("./codex-hooks.base.json", import.meta.url))) {
    const overlay = readHookConfiguration(declarationPath);
    for (const [eventName, entries] of Object.entries(overlay.hooks)) {
      declaration.hooks[eventName] = [...(declaration.hooks[eventName] ?? []), ...entries];
    }
  }
  if (ownedCommandsPath && fs.existsSync(ownedCommandsPath)) {
    if (!fs.lstatSync(ownedCommandsPath).isFile()) throw new Error("owned hook commands must be a plain file");
    ownedCommands = new Set(JSON.parse(fs.readFileSync(ownedCommandsPath, "utf8")));
  }
  const renderedDeclaration = JSON.parse(
    JSON.stringify(declaration).replaceAll("{{HOME}}", JSON.stringify(os.homedir()).slice(1, -1)),
  );
  const declaredCommands = Object.values(renderedDeclaration.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((handler) => handler.command)));
  for (const command of declaredCommands) ownedCommands.add(command);
  const configuration = readHookConfiguration(runtimePath);
  for (const [eventName, entries] of Object.entries(configuration.hooks)) {
    if (!Array.isArray(entries)) throw new Error(`invalid hook entries: ${eventName}`);
    configuration.hooks[eventName] = entries.flatMap((entry) => {
      if (!Array.isArray(entry.hooks)) throw new Error(`invalid hook handlers: ${eventName}`);
      const handlers = entry.hooks.filter((handler) => !isOwnedHook(handler));
      if (handlers.length === 0) return [];
      return [{ ...entry, hooks: handlers }];
    });
    if (configuration.hooks[eventName].length === 0) delete configuration.hooks[eventName];
  }
  for (const [eventName, entries] of Object.entries(renderedDeclaration.hooks)) {
    configuration.hooks[eventName] = [...entries, ...(configuration.hooks[eventName] || [])];
  }
  if (ownedCommandsPath) {
    const stagedCommandsPath = `${ownedCommandsPath}.${process.pid}`;
    fs.writeFileSync(stagedCommandsPath, JSON.stringify([...ownedCommands]) + "\n", { mode: 0o600 });
    fs.renameSync(stagedCommandsPath, ownedCommandsPath);
  }
  fs.writeFileSync(destinationPath, JSON.stringify(configuration, null, 2) + "\n", { mode: 0o600 });
} catch (renderError) {
  process.stderr.write(`render-codex-hooks: ${renderError.message}\n`);
  process.exitCode = 1;
}
