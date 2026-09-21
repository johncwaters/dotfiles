import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(jsonPath) {
  let jsonText;
  try {
    jsonText = fs.readFileSync(jsonPath, "utf8");
  } catch (readError) {
    throw new Error("cannot read " + jsonPath + ": " + readError.message);
  }
  try {
    return JSON.parse(jsonText);
  } catch (parseError) {
    throw new Error("cannot parse JSON in " + jsonPath + ": " + parseError.message);
  }
}

export function deepMergeJson(baseValue, overlayValue, mergeProperty) {
  if (!isPlainObject(baseValue) || !isPlainObject(overlayValue)) {
    return overlayValue;
  }
  const mergedValue = {};
  for (const key of Object.keys(baseValue)) {
    if (!Object.prototype.hasOwnProperty.call(overlayValue, key)) {
      mergedValue[key] = baseValue[key];
      continue;
    }
    const customValue = mergeProperty?.({
      key,
      baseValue: baseValue[key],
      overlayValue: overlayValue[key],
    });
    if (customValue !== undefined) {
      mergedValue[key] = customValue;
      continue;
    }
    mergedValue[key] = deepMergeJson(baseValue[key], overlayValue[key], mergeProperty);
  }
  for (const key of Object.keys(overlayValue)) {
    if (Object.prototype.hasOwnProperty.call(mergedValue, key)) {
      continue;
    }
    mergedValue[key] = overlayValue[key];
  }
  return mergedValue;
}

export function mergeJsonFiles({
  basePath,
  overlayPath,
  destinationPath,
  home = os.homedir(),
  mergeProperty,
}) {
  const overlayValue = overlayPath ? readJson(overlayPath) : {};
  const mergedValue = deepMergeJson(
    readJson(basePath),
    overlayValue,
    mergeProperty,
  );
  const normalizedHome = home.replace(/\\/g, "/");
  const escapedHome = JSON.stringify(normalizedHome).slice(1, -1);
  const renderedText = (JSON.stringify(mergedValue, null, 2) + "\n")
    .split("{{HOME}}")
    .join(escapedHome);
  fs.writeFileSync(destinationPath, renderedText, { encoding: "utf8", mode: 0o600 });
}

function runCommandLine() {
  const [basePath, overlayPath, destinationPath, homeOverride] = process.argv.slice(2);
  if (!basePath || !destinationPath) {
    process.stderr.write(
      "merge-json: usage: node merge-json.mjs <base.json> <overlay.json-or-empty> <out.json> [homeOverride]\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    mergeJsonFiles({
      basePath,
      overlayPath,
      destinationPath,
      home: homeOverride || os.homedir(),
    });
  } catch (mergeError) {
    process.stderr.write("merge-json: " + mergeError.message + "\n");
    process.exitCode = 1;
  }
}

// import.meta.url is symlink-resolved, so an invocation through ~/.dotfiles never matches a raw argv[1].
function invokedScriptHref() {
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return "";
  }
}

if (process.argv[1] && invokedScriptHref() === import.meta.url) {
  runCommandLine();
}
