import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POSTHOG_ORIGIN = /^(?:(?:https|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:)posthog\//i;

export function gitOutput(directory, gitArguments) {
  const gitResult = spawnSync("git", ["-C", directory, ...gitArguments], { encoding: "utf8" });
  if (gitResult.status !== 0) return "";
  return gitResult.stdout.trim();
}

export function isSameFilesystemObject(firstPath, secondPath) {
  if (!firstPath || !secondPath) return false;
  const firstStat = fs.statSync(firstPath, { throwIfNoEntry: false });
  const secondStat = fs.statSync(secondPath, { throwIfNoEntry: false });
  if (!firstStat || !secondStat) return false;
  return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
}

function normalizedGitHubOrigin(originUrl) {
  const repositoryMatch = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)\/?$/i.exec(originUrl);
  if (!repositoryMatch) return "";
  return repositoryMatch[1].replace(/\.git$/i, "").toLowerCase();
}

export function isWorkRepository(directory) {
  const originUrl = gitOutput(directory, ["remote", "get-url", "origin"]);
  if (POSTHOG_ORIGIN.test(originUrl)) return true;
  const profilePolicy = JSON.parse(fs.readFileSync(new URL("../ai.json", import.meta.url), "utf8"));
  const repositoryOrigin = profilePolicy.mcpServers?.backchannels?.repositoryOrigin;
  const declaredOrigin = normalizedGitHubOrigin(repositoryOrigin);
  if (declaredOrigin && normalizedGitHubOrigin(originUrl) === declaredOrigin) return true;
  const backchannelGitDirectory = path.join(os.homedir(), "Projects", "backchannel", ".git");
  const commonGitDirectory = gitOutput(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return isSameFilesystemObject(commonGitDirectory, backchannelGitDirectory);
}
