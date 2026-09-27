import fs from "node:fs";
import os from "node:os";
import { mergeJsonFiles } from "../script/lib/merge-json.mjs";
import { buildClaudeProtectedReadRules } from "./protected-paths.mjs";

function mergeHookEvents(baseHooks, overlayHooks) {
  const mergedHooks = { ...baseHooks };
  for (const event of Object.keys(overlayHooks)) {
    const baseEventHooks = Array.isArray(mergedHooks[event]) ? mergedHooks[event] : [];
    const overlayEventHooks = Array.isArray(overlayHooks[event]) ? overlayHooks[event] : [];
    mergedHooks[event] = [...baseEventHooks, ...overlayEventHooks];
  }
  return mergedHooks;
}

function mergeAllowLists(baseAllowList, overlayAllowList) {
  if (!Array.isArray(baseAllowList) || !Array.isArray(overlayAllowList)) {
    return undefined;
  }
  return [...new Set([...baseAllowList, ...overlayAllowList])];
}

const [basePath, overlayPath, destinationPath, homeOverride] = process.argv.slice(2);
if (!basePath || !overlayPath || !destinationPath) {
  process.stderr.write(
    "render-settings: usage: node render-settings.mjs <base.json> <overlay.json> <out.json> [homeOverride]\n",
  );
  process.exit(1);
}

try {
  mergeJsonFiles({
    basePath,
    overlayPath,
    destinationPath,
    home: homeOverride || os.homedir(),
    mergeProperty: ({ key, baseValue, overlayValue }) => {
      if (key === "allow") {
        return mergeAllowLists(baseValue, overlayValue);
      }
      if (key !== "hooks") {
        return undefined;
      }
      if (
        baseValue === null ||
        typeof baseValue !== "object" ||
        Array.isArray(baseValue)
      ) {
        return undefined;
      }
      if (
        overlayValue === null ||
        typeof overlayValue !== "object" ||
        Array.isArray(overlayValue)
      ) {
        return undefined;
      }
      return mergeHookEvents(baseValue, overlayValue);
    },
  });
  const renderedSettings = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
  if (Array.isArray(renderedSettings.permissions?.deny)) {
    renderedSettings.permissions.deny.push(...buildClaudeProtectedReadRules());
    fs.writeFileSync(destinationPath, JSON.stringify(renderedSettings, null, 2) + "\n", { mode: 0o600 });
  }
} catch (renderError) {
  process.stderr.write("render-settings: " + renderError.message + "\n");
  process.exit(1);
}
