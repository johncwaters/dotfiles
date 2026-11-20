import fs from "node:fs";
import os from "node:os";

const [basePath, declarationPath, runtimePath, destinationPath, ownedCommandsPath, groupName] = process.argv.slice(2);

function assertEventMap(events, configurationPath) {
  if (!events || typeof events !== "object" || Array.isArray(events)) {
    throw new Error(`invalid hook events: ${configurationPath}`);
  }
}

function readConfiguration(configurationPath) {
  if (!fs.existsSync(configurationPath)) return {};
  const configuration = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error(`invalid hook configuration: ${configurationPath}`);
  }
  return configuration;
}

function readDeclaration(configurationPath) {
  const configuration = readConfiguration(configurationPath);
  configuration.hooks ??= {};
  assertEventMap(configuration.hooks, configurationPath);
  return configuration;
}

function eventMapOf(configuration, configurationPath) {
  const eventKey = groupName || "hooks";
  configuration[eventKey] ??= {};
  assertEventMap(configuration[eventKey], configurationPath);
  return configuration[eventKey];
}

let ownedCommands = new Set();

function withoutOwnedHandlers(entry, eventName) {
  if (entry && typeof entry.command === "string" && !Array.isArray(entry.hooks)) {
    return ownedCommands.has(entry.command) ? [] : [entry];
  }
  if (!entry || !Array.isArray(entry.hooks)) throw new Error(`invalid hook handlers: ${eventName}`);
  const handlers = entry.hooks.filter((handler) => !ownedCommands.has(handler.command));
  if (handlers.length === 0) return [];
  return [{ ...entry, hooks: handlers }];
}

function handlersOf(entry) {
  return Array.isArray(entry.hooks) ? entry.hooks : [entry];
}

try {
  const declaration = readDeclaration(basePath);
  if (fs.realpathSync(declarationPath) !== fs.realpathSync(basePath)) {
    const overlay = readDeclaration(declarationPath);
    for (const [eventName, entries] of Object.entries(overlay.hooks)) {
      declaration.hooks[eventName] = [...(declaration.hooks[eventName] ?? []), ...entries];
    }
  }
  if (ownedCommandsPath && fs.existsSync(ownedCommandsPath)) {
    if (!fs.lstatSync(ownedCommandsPath).isFile()) throw new Error("owned hook commands must be a plain file");
    ownedCommands = new Set(JSON.parse(fs.readFileSync(ownedCommandsPath, "utf8")));
  }
  const renderedEvents = JSON.parse(
    JSON.stringify(declaration.hooks).replaceAll("{{HOME}}", JSON.stringify(os.homedir()).slice(1, -1)),
  );
  const declaredCommands = Object.values(renderedEvents).flatMap((entries) => entries.flatMap((entry) => handlersOf(entry).map((handler) => handler.command)));
  for (const command of declaredCommands) ownedCommands.add(command);
  const configuration = readConfiguration(runtimePath);
  const runtimeEvents = eventMapOf(configuration, runtimePath);
  for (const [eventName, entries] of Object.entries(runtimeEvents)) {
    if (!Array.isArray(entries)) throw new Error(`invalid hook entries: ${eventName}`);
    runtimeEvents[eventName] = entries.flatMap((entry) => withoutOwnedHandlers(entry, eventName));
    if (runtimeEvents[eventName].length === 0) delete runtimeEvents[eventName];
  }
  for (const [eventName, entries] of Object.entries(renderedEvents)) {
    runtimeEvents[eventName] = [...entries, ...(runtimeEvents[eventName] || [])];
  }
  if (ownedCommandsPath) {
    const stagedCommandsPath = `${ownedCommandsPath}.${process.pid}`;
    fs.writeFileSync(stagedCommandsPath, JSON.stringify([...ownedCommands]) + "\n", { mode: 0o600 });
    fs.renameSync(stagedCommandsPath, ownedCommandsPath);
  }
  fs.writeFileSync(destinationPath, JSON.stringify(configuration, null, 2) + "\n", { mode: 0o600 });
} catch (renderError) {
  process.stderr.write(`render-hooks: ${renderError.message}\n`);
  process.exitCode = 1;
}
