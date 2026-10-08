import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const [declarationPath, runtimePath, destinationPath, trustEpoch = ""] = process.argv.slice(2);

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

function isBackchannelsHook(handler) {
  return /(?:confine-backchannels\.mjs|\.agents[\\/]skills[\\/]backchannels[\\/]session-start)/i.test(String(handler.command || ""));
}

function snakeCaseEventName(eventName) {
  return eventName.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase();
}

// Codex keys hook trust in config.toml by this position, which owned entries hold by rendering first.
function trustStateKeys(hooksByEvent) {
  return Object.entries(hooksByEvent).flatMap(([eventName, entries]) =>
    entries.flatMap((entry, entryIndex) =>
      entry.hooks.map((_, handlerIndex) => `${runtimePath}:${snakeCaseEventName(eventName)}:${entryIndex}:${handlerIndex}`),
    ),
  );
}

try {
  const declaration = readHookConfiguration(declarationPath);
  const configuration = readHookConfiguration(runtimePath);
  for (const [eventName, entries] of Object.entries(configuration.hooks)) {
    if (!Array.isArray(entries)) throw new Error(`invalid hook entries: ${eventName}`);
    configuration.hooks[eventName] = entries.flatMap((entry) => {
      if (!Array.isArray(entry.hooks)) throw new Error(`invalid hook handlers: ${eventName}`);
      const handlers = entry.hooks.filter((handler) => !isBackchannelsHook(handler));
      if (handlers.length === 0) return [];
      return [{ ...entry, hooks: handlers }];
    });
    if (configuration.hooks[eventName].length === 0) delete configuration.hooks[eventName];
  }
  const declarationText = JSON.stringify(declaration);
  if (declarationText.includes("{{TRUST_EPOCH}}") && !/^[A-Za-z0-9-]+$/.test(trustEpoch)) {
    throw new Error(`missing or unsafe trust epoch for ${declarationPath}`);
  }
  const renderedDeclaration = JSON.parse(
    declarationText.replaceAll("{{HOME}}", JSON.stringify(os.homedir()).slice(1, -1)).replaceAll("{{TRUST_EPOCH}}", trustEpoch),
  );
  for (const [eventName, entries] of Object.entries(renderedDeclaration.hooks)) {
    configuration.hooks[eventName] = [...entries, ...(configuration.hooks[eventName] || [])];
  }
  fs.writeFileSync(destinationPath, JSON.stringify(configuration, null, 2) + "\n", { mode: 0o600 });
  const ownedStateKeys = trustStateKeys(renderedDeclaration.hooks);
  const ownedFingerprint = createHash("sha256").update(JSON.stringify([ownedStateKeys, renderedDeclaration.hooks])).digest("hex");
  process.stdout.write([ownedFingerprint, ...ownedStateKeys].join("\n") + "\n");
} catch (renderError) {
  process.stderr.write(`render-codex-hooks: ${renderError.message}\n`);
  process.exitCode = 1;
}
