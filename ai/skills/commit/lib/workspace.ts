import type { Git } from "./git.ts";

export const MAINLINE_CANDIDATES = ["main", "master"] as const;

const DENYLIST_DIR_PREFIXES = ["node_modules/", "dist/", "__pycache__/"] as const;

export type Scope = { changed: Set<string>; untracked: string[] };

export function isDenylisted(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const prefix of DENYLIST_DIR_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return true;
    }
  }
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.startsWith(".env") || basename.endsWith(".log");
}

export function computeScope(git: Git, paths: string[]): Scope {
  const changed = new Set([
    ...git.diffNameOnly({ cached: false, paths }),
    ...git.diffNameOnly({ cached: true, paths }),
  ]);
  const untracked: string[] = [];
  for (const line of git.statusShort(paths)) {
    if (!line.startsWith("??")) {
      continue;
    }
    const filePath = line.slice(3).trim();
    if (isDenylisted(filePath)) {
      continue;
    }
    untracked.push(filePath);
  }
  return { changed, untracked };
}

function originHeadBranch(git: Git): string | null {
  const originHead = git.symbolicRef("refs/remotes/origin/HEAD");
  const prefix = "refs/remotes/origin/";
  if (!originHead?.startsWith(prefix)) {
    return null;
  }
  if (!git.verifyRef(originHead)) {
    return null;
  }
  return originHead.slice(prefix.length);
}

export function resolveMainline(git: Git, configuredMainline: unknown = "auto"): string | null {
  if (typeof configuredMainline === "string" && configuredMainline !== "auto") {
    if (
      git.verifyRef(`refs/heads/${configuredMainline}`) ||
      git.verifyRef(`refs/remotes/origin/${configuredMainline}`)
    ) {
      return configuredMainline;
    }
    return null;
  }

  const remoteDefault = originHeadBranch(git);
  if (remoteDefault !== null) {
    return remoteDefault;
  }
  for (const name of MAINLINE_CANDIDATES) {
    if (git.verifyRef(`refs/heads/${name}`) || git.verifyRef(`refs/remotes/origin/${name}`)) {
      return name;
    }
  }
  return null;
}

export function findWorktreeForBranch(porcelainText: string, branch: string): string | null {
  const target = `refs/heads/${branch}`;
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  for (const line of [...porcelainText.split("\n"), ""]) {
    if (line.trim() === "") {
      if (worktreePath && worktreeBranch === target) {
        return worktreePath;
      }
      worktreePath = null;
      worktreeBranch = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ")) {
      worktreeBranch = line.slice("branch ".length);
    }
  }
  return null;
}
