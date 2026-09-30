import { spawnSync } from "node:child_process";
import type { Git } from "./git.ts";

export type RemoteVisibility =
  | { remote: string; visibility: "public" | "private" | "internal" }
  | { remote: string; visibility: "unknown"; reason: string };

const GITHUB_REMOTE_PATTERN = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const GH_TIMEOUT_MS = 10_000;
const KNOWN_VISIBILITIES = new Set(["public", "private", "internal"]);

export function githubRepositoryName(remoteUrl: string): string | null {
  return GITHUB_REMOTE_PATTERN.exec(remoteUrl.trim())?.[1] ?? null;
}

export function readRemoteVisibility(git: Git, remote = "origin"): RemoteVisibility {
  const remoteUrl = git.run(["remote", "get-url", remote]);
  if (remoteUrl.code !== 0) {
    return { remote, visibility: "unknown", reason: `no ${remote} remote` };
  }
  const repositoryName = githubRepositoryName(remoteUrl.stdout);
  if (repositoryName === null) {
    return { remote, visibility: "unknown", reason: `${remote} is not a GitHub remote` };
  }
  const hostQualifiedName = `github.com/${repositoryName}`;
  const lookup = spawnSync(
    "gh",
    ["repo", "view", hostQualifiedName, "--json", "visibility", "--jq", ".visibility"],
    { encoding: "utf8", timeout: GH_TIMEOUT_MS },
  );
  const visibility = (lookup.stdout ?? "").trim().toLowerCase();
  if (lookup.status !== 0 || !KNOWN_VISIBILITIES.has(visibility)) {
    const detail = (lookup.stderr ?? "").trim() || lookup.error?.message || "no visibility returned";
    return { remote, visibility: "unknown", reason: `gh repo view ${hostQualifiedName} failed: ${detail}` };
  }
  return { remote, visibility: visibility as "public" | "private" | "internal" };
}
