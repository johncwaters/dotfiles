import os from "node:os";
import { mergeJsonFiles } from "../script/lib/merge-json.mjs";

function mergeHookEvents(baseHooks, overlayHooks) {
  const mergedHooks = {};
  for (const event of Object.keys(baseHooks)) {
    mergedHooks[event] = baseHooks[event];
  }
  for (const event of Object.keys(overlayHooks)) {
    const baseEventHooks = Array.isArray(mergedHooks[event]) ? mergedHooks[event] : [];
    const overlayEventHooks = Array.isArray(overlayHooks[event]) ? overlayHooks[event] : [];
    mergedHooks[event] = [...baseEventHooks, ...overlayEventHooks];
  }
  return mergedHooks;
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
} catch (renderError) {
  process.stderr.write("render-settings: " + renderError.message + "\n");
  process.exit(1);
}
