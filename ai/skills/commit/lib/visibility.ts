import { spawnSync } from "node:child_process";
import type { Git } from "./git.ts";

export type RemoteVisibility =
  | { remote: string; visibility: "public" | "private" | "internal" }
  | { remote: string; visibility: "unknown"; reason: string };

type GithubRemote =
  | { remote: string; repositoryName: string; hasRemote: true }
  | { remote: string; repositoryName: null; hasRemote: boolean; reason: string };

type AfterCommitResolution = {
  mode: "promote" | "pull-request";
  warning?: string;
};

const GITHUB_REMOTE_PATTERN = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const GH_TIMEOUT_MS = 10_000;
const KNOWN_VISIBILITIES = new Set(["public", "private", "internal"]);

export function githubRepositoryName(remoteUrl: string): string | null {
  return GITHUB_REMOTE_PATTERN.exec(remoteUrl.trim())?.[1] ?? null;
}

export function readGithubRemote(git: Git, remote = "origin"): GithubRemote {
  const remoteUrl = git.run(["remote", "get-url", remote]);
  if (remoteUrl.code !== 0) {
    return { remote, repositoryName: null, hasRemote: false, reason: `no ${remote} remote` };
  }
  const repositoryName = githubRepositoryName(remoteUrl.stdout);
  if (repositoryName === null) {
    return { remote, repositoryName: null, hasRemote: true, reason: `${remote} is not a GitHub remote` };
  }
  return { remote, repositoryName, hasRemote: true };
}

export function resolveAfterCommit(origin: GithubRemote): AfterCommitResolution {
  if (origin.repositoryName === null) {
    if (!origin.hasRemote) {
      return { mode: "promote" };
    }
    return leaveForPullRequest(origin.reason);
  }
  const lookup = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
  });
  const login = (lookup.stdout ?? "").trim();
  if (lookup.status !== 0 || login === "") {
    const detail = (lookup.stderr ?? "").trim() || lookup.error?.message || "no login returned";
    return leaveForPullRequest(`gh api user --jq .login failed: ${detail}`);
  }
  const owner = origin.repositoryName.split("/")[0];
  if (owner.toLowerCase() !== login.toLowerCase()) {
    return { mode: "pull-request" };
  }
  return resolveOwnedRepository(origin.repositoryName, login);
}

function leaveForPullRequest(reason: string): AfterCommitResolution {
  return { mode: "pull-request", warning: `${reason}; leaving the branch for a pull request` };
}

function resolveOwnedRepository(repositoryName: string, login: string): AfterCommitResolution {
  const ownershipLookup = spawnSync(
    "gh",
    ["repo", "view", `github.com/${repositoryName}`, "--json", "isFork,owner", "--jq", "[.owner.login, .isFork] | @tsv"],
    { encoding: "utf8", timeout: GH_TIMEOUT_MS },
  );
  const [resolvedOwner = "", isForkAnswer = ""] = (ownershipLookup.stdout ?? "").trim().split("\t");
  if (ownershipLookup.status !== 0 || resolvedOwner === "" || !["true", "false"].includes(isForkAnswer)) {
    const detail = (ownershipLookup.stderr ?? "").trim() || ownershipLookup.error?.message || "no owner and isFork returned";
    return leaveForPullRequest(`gh repo view github.com/${repositoryName} failed: ${detail}`);
  }
  const isOwnedByLogin = resolvedOwner.toLowerCase() === login.toLowerCase();
  return { mode: isOwnedByLogin && isForkAnswer === "false" ? "promote" : "pull-request" };
}

export function readRemoteVisibility(origin: GithubRemote): RemoteVisibility {
  if (origin.repositoryName === null) {
    return { remote: origin.remote, visibility: "unknown", reason: origin.reason };
  }
  const { remote, repositoryName } = origin;
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
