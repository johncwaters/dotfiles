import { spawnSync } from "node:child_process";
import os from "node:os";

export type GitResult = { code: number; stdout: string; stderr: string };

export type PushRefStatus = "ok" | "up_to_date" | "rejected" | "error" | "unknown";

export type PushRefResult = { status: PushRefStatus; summary: string };

export type PushResult = GitResult & { refs: Record<string, PushRefResult> };

function scoped(args: string[], paths: string[]): string[] {
  if (paths.length === 0) {
    return args;
  }
  return [...args, "--", ...paths];
}

export type AddedLine = { filePath: string; lineNumber: number; text: string };

export type AddedLinesScan = { addedLines: AddedLine[]; failure: string | null };

function parseAddedLines(diffText: string): AddedLine[] {
  const addedLines: AddedLine[] = [];
  let filePath = "";
  let nextLineNumber = 0;
  let isInsideHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      isInsideHunk = false;
      continue;
    }
    if (!isInsideHunk && line.startsWith("+++ ")) {
      filePath = line.slice("+++ ".length).replace(/^b\//, "");
      continue;
    }
    const hunkStart = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunkStart) {
      isInsideHunk = true;
      nextLineNumber = Number(hunkStart[1]);
      continue;
    }
    if (isInsideHunk && line.startsWith("+")) {
      addedLines.push({ filePath, lineNumber: nextLineNumber, text: line.slice(1) });
      nextLineNumber += 1;
    }
  }
  return addedLines;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

const INHERITED_GIT_CONFIG_ENV = /^GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS)?$/;

const OID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const REMOTE_QUERY_TIMEOUT_MS = 30_000;

function promptSuppressionEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    SSH_ASKPASS_REQUIRE: "force",
    GCM_INTERACTIVE: "never",
  };
}

function envWithoutGitConfigInjection(): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || INHERITED_GIT_CONFIG_ENV.test(name)) {
      continue;
    }
    childEnv[name] = value;
  }
  return childEnv;
}

function envWithoutAnyInheritedGitConfig(): Record<string, string> {
  return {
    ...envWithoutGitConfigInjection(),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function withConfigEntries(
  baseEnv: Record<string, string>,
  entries: Array<[string, string]>,
): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv, GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([name, value], index) => {
    childEnv[`GIT_CONFIG_KEY_${index}`] = name;
    childEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return childEnv;
}

export class Git {
  readonly repo: string;

  private cachedEmptyTreeOid: string | null = null;

  constructor(repo: string) {
    this.repo = repo;
  }

  run(
    args: string[],
    options: {
      cwd?: string;
      input?: string;
      env?: Record<string, string>;
      replacesInheritedEnv?: boolean;
      timeoutMs?: number;
      noPrompt?: boolean;
    } = {},
  ): GitResult {
    const inherited = options.replacesInheritedEnv ? {} : process.env;
    const proc = spawnSync("git", args, {
      cwd: options.cwd ?? this.repo,
      input: options.input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: {
        ...inherited,
        ...(options.env ?? {}),
        ...(options.noPrompt ? promptSuppressionEnv() : {}),
      },
    });
    return {
      code: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  }

  isInsideWorkTree(): boolean {
    const proc = this.run(["rev-parse", "--is-inside-work-tree"]);
    return proc.code === 0 && proc.stdout.trim() === "true";
  }

  currentBranch(): string {
    const symbolicBranch = this.run(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (symbolicBranch.code === 0) {
      return symbolicBranch.stdout.trim();
    }
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  }

  isHeadUnborn(): boolean {
    return this.run(["rev-parse", "-q", "--verify", "HEAD"]).code !== 0;
  }

  verifyRef(ref: string): boolean {
    return this.run(["rev-parse", "-q", "--verify", ref]).code === 0;
  }

  revParseRef(ref: string): string | null {
    const proc = this.run(["rev-parse", "-q", "--verify", ref]);
    if (proc.code !== 0) {
      return null;
    }
    return proc.stdout.trim();
  }

  revParseHead(): string | null {
    return this.revParseRef("HEAD");
  }

  commonDir(): string {
    return this.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  }

  symbolicRef(ref: string): string | null {
    const proc = this.run(["symbolic-ref", "-q", ref]);
    if (proc.code !== 0) {
      return null;
    }
    return proc.stdout.trim();
  }

  revList(range: string): string[] {
    return nonEmptyLines(this.run(["rev-list", "--reverse", range]).stdout);
  }

  mergeBase(a: string, b: string): string | null {
    const mergeBase = this.run(["merge-base", a, b]);
    if (mergeBase.code !== 0) {
      return null;
    }
    return mergeBase.stdout.trim();
  }

  fetchRemoteBranch(
    remote: string,
    branch: string,
    options: { timeoutMs?: number; noPrompt?: boolean } = {},
  ): GitResult {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const refspec = `+refs/heads/${branch}:${remoteRef}`;
    return this.run(["fetch", remote, refspec], options);
  }

  fetchLocalFf(src: string, dst: string): GitResult {
    return this.run(["fetch", ".", `${src}:${dst}`]);
  }

  createTrackingBranch(branch: string, remoteRef: string): GitResult {
    return this.run(["branch", "--track", branch, remoteRef]);
  }

  worktreeListPorcelain(): GitResult {
    return this.run(["worktree", "list", "--porcelain"]);
  }

  addDetachedWorktree(worktreePath: string, commit: string): GitResult {
    return this.run(["worktree", "add", "--detach", worktreePath, commit]);
  }

  removeWorktree(worktreePath: string): GitResult {
    return this.run(["worktree", "remove", "--force", worktreePath]);
  }

  pruneWorktrees(): GitResult {
    return this.run(["worktree", "prune"]);
  }

  rebaseIn(worktreePath: string, ref: string): GitResult {
    return this.run(["rebase", ref], { cwd: worktreePath });
  }

  rebaseAbortIn(worktreePath: string): GitResult {
    return this.run(["rebase", "--abort"], { cwd: worktreePath });
  }

  revParseHeadIn(worktreePath: string): string | null {
    const proc = this.run(["rev-parse", "-q", "--verify", "HEAD"], { cwd: worktreePath });
    if (proc.code !== 0) {
      return null;
    }
    return proc.stdout.trim();
  }

  resetKeep(commit: string): GitResult {
    return this.run(["reset", "--keep", commit]);
  }

  mergeFfOnlyIn(worktreePath: string, ref: string): GitResult {
    return this.run(["merge", "--ff-only", ref], { cwd: worktreePath });
  }

  conflictingFilesIn(worktreePath: string): string[] {
    return nonEmptyLines(
      this.run(["diff", "--name-only", "--diff-filter=U"], { cwd: worktreePath }).stdout,
    );
  }

  stagedAdditions(): string[] {
    return nonEmptyLines(
      this.run(["diff", "--cached", "--name-only", "--diff-filter=A"]).stdout,
    );
  }

  stagedAddedLines(): AddedLinesScan {
    return this.addedLinesOfDiff(["--cached"]);
  }

  headAddedLines(): AddedLinesScan {
    const parentCommit = this.revParseRef("HEAD^");
    return this.addedLinesOfDiff([parentCommit ?? this.emptyTreeOid(), "HEAD"]);
  }

  headMessage(): string | null {
    const messageRun = this.run(["log", "-1", "--format=%B", "HEAD"]);
    if (messageRun.code !== 0) {
      return null;
    }
    return messageRun.stdout;
  }

  resetSoft(commit: string): GitResult {
    return this.run(["reset", "--soft", commit]);
  }

  deleteHeadRef(): GitResult {
    return this.run(["update-ref", "-d", "HEAD"]);
  }

  private addedLinesOfDiff(revisionArgs: string[]): AddedLinesScan {
    const diffArgs = [
      "diff",
      ...revisionArgs,
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--no-relative",
    ];
    const diffRun = this.run(diffArgs);
    if (diffRun.code !== 0) {
      return { addedLines: [], failure: diffRun.stderr.trim() || `git diff exited ${diffRun.code}` };
    }
    return { addedLines: parseAddedLines(diffRun.stdout), failure: null };
  }

  // The empty tree oid differs between sha1 and sha256 repositories, so it is hashed per repo.
  private emptyTreeOid(): string {
    if (this.cachedEmptyTreeOid !== null) {
      return this.cachedEmptyTreeOid;
    }
    const hashRun = this.run(["hash-object", "-t", "tree", os.devNull]);
    const hashedEmptyTree = hashRun.stdout.trim();
    if (hashRun.code !== 0 || !OID_PATTERN.test(hashedEmptyTree)) {
      throw new Error(
        `git hash-object -t tree failed (exit ${hashRun.code}): ${hashRun.stderr.trim()}`,
      );
    }
    this.cachedEmptyTreeOid = hashedEmptyTree;
    return hashedEmptyTree;
  }

  diffNameOnly(options: { cached?: boolean; paths?: string[] } = {}): string[] {
    if (options.cached) {
      return nonEmptyLines(this.run(scoped(["diff", "--cached", "--name-only"], options.paths ?? [])).stdout);
    }
    const base = this.isHeadUnborn() ? this.emptyTreeOid() : "HEAD";
    return nonEmptyLines(this.run(scoped(["diff", "--name-only", base], options.paths ?? [])).stdout);
  }

  // Collapsed untracked directories would hide secrets from the scope denylist.
  statusShort(paths: string[] = []): string[] {
    return nonEmptyLines(this.run(scoped(["status", "--short", "-uall"], paths)).stdout);
  }

  gitPath(name: string): string {
    return this.run(["rev-parse", "--path-format=absolute", "--git-path", name]).stdout.trim();
  }

  gitPathIn(worktreePath: string, gitPath: string): string | null {
    const proc = this.run(["rev-parse", "--path-format=absolute", "--git-path", gitPath], { cwd: worktreePath });
    if (proc.code !== 0) {
      return null;
    }
    return proc.stdout.trim();
  }

  pathsChangedByFastForwardIn(worktreePath: string, ref: string): string[] | null {
    const proc = this.run(["diff", "--name-only", "--no-renames", "-z", "HEAD", ref], { cwd: worktreePath });
    if (proc.code !== 0) {
      return null;
    }
    return proc.stdout.split("\0").filter((changedPath) => changedPath.length > 0);
  }

  statusShortIn(worktreePath: string): string[] {
    return nonEmptyLines(this.run(["status", "--short"], { cwd: worktreePath }).stdout);
  }

  addUpdate(paths: string[] = []): GitResult {
    if (paths.length === 0) {
      return this.run(["add", "-u"]);
    }
    const pathsInIndex: string[] = [];
    for (const pathspec of paths) {
      const indexListing = this.run(["ls-files", "-t", "--", pathspec]);
      if (indexListing.code !== 0) {
        return indexListing;
      }
      const hasEntryInsideSparseCone = nonEmptyLines(indexListing.stdout).some((line) => !line.startsWith("S "));
      if (hasEntryInsideSparseCone) {
        pathsInIndex.push(pathspec);
      }
    }
    if (pathsInIndex.length === 0) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return this.run(["add", "-u", "--", ...pathsInIndex]);
  }

  addPath(path: string): GitResult {
    return this.run(["add", "--", path]);
  }

  unstage(paths: string[]): GitResult {
    if (this.isHeadUnborn()) {
      return this.run(["rm", "--cached", "-r", "-f", "--quiet", "--", ...paths]);
    }
    return this.run(["restore", "--staged", "--", ...paths]);
  }

  commit(message: string): GitResult {
    return this.run(["commit", "-F", "-"], { input: message });
  }

  listRemotes(): string[] {
    return this.run(["remote"]).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  hasUpstream(): boolean {
    return this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code === 0;
  }

  resolveFeaturePushTarget(branch: string, mainlineBranchNames: readonly string[]): {
    remote: string;
    destination: string;
    trackingRef: string;
    hasUpstream: boolean;
  } {
    const listing = this.run([
      "for-each-ref",
      "--format=%(push:remotename) %(upstream:remotename) %(upstream:remoteref) %(upstream)",
      `refs/heads/${branch}`,
    ]);
    const [pushRemote, upstreamRemote, upstreamDestination, upstreamTrackingRef] = listing.stdout.split("\n")[0].split(" ");
    const remote = pushRemote || "origin";
    const upstreamBranchName = upstreamDestination.replace(/^refs\/heads\//, "");
    const tracksMainlineBranch = mainlineBranchNames.includes(upstreamBranchName);
    const followsUpstreamDestination = remote === upstreamRemote && !tracksMainlineBranch;
    return {
      remote,
      destination: followsUpstreamDestination ? upstreamDestination : `refs/heads/${branch}`,
      trackingRef: followsUpstreamDestination ? upstreamTrackingRef : `refs/remotes/${remote}/${branch}`,
      hasUpstream: Boolean(upstreamTrackingRef),
    };
  }

  deleteRemoteBranch(options: { remote: string; branch: string; expectedTip: string }): GitResult {
    return this.run([
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${options.branch}:${options.expectedTip}`,
      options.remote,
      `:refs/heads/${options.branch}`,
    ]);
  }

  remoteBranchTip(remote: string, branch: string): string | null {
    const listing = this.run(["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
      noPrompt: true,
      timeoutMs: REMOTE_QUERY_TIMEOUT_MS,
    });
    if (listing.code !== 0) {
      return null;
    }
    const firstListedRef = nonEmptyLines(listing.stdout)[0];
    if (firstListedRef === undefined) {
      return null;
    }
    const tip = (firstListedRef.split(/\s+/)[0] ?? "").trim();
    if (!OID_PATTERN.test(tip)) {
      return null;
    }
    return tip;
  }

  isAncestor(ancestorRef: string, descendantRef: string): boolean {
    return this.run(["merge-base", "--is-ancestor", ancestorRef, descendantRef]).code === 0;
  }

  configuredMergeDriverKeys(childEnv: Record<string, string>): string[] | null {
    const keys = this.run(["config", "--name-only", "--get-regexp", "^merge\\..+\\.driver$"], {
      env: childEnv,
      replacesInheritedEnv: true,
    });
    if (keys.code === 1) {
      return [];
    }
    if (keys.code !== 0) {
      return null;
    }
    return nonEmptyLines(keys.stdout)
      .map((key) => key.trim())
      .filter((key) => /^merge\..+\.driver$/.test(key));
  }

  inheritedSafeDirectories(): string[] {
    const uninjectedEnv = envWithoutGitConfigInjection();
    const listed = ["--system", "--global"].flatMap((scope) =>
      nonEmptyLines(
        this.run(["config", scope, "--get-all", "safe.directory"], {
          env: uninjectedEnv,
          replacesInheritedEnv: true,
        }).stdout,
      ),
    );
    return [...new Set(listed.map((safeDirectory) => safeDirectory.trim()).filter(Boolean))];
  }

  mergeTree(base: string, head: string): GitResult {
    const hardenedEnv = envWithoutAnyInheritedGitConfig();
    const safeDirectoryEntries = this.inheritedSafeDirectories().map(
      (safeDirectory) => ["safe.directory", safeDirectory] as [string, string],
    );
    const configuredDriverKeys = this.configuredMergeDriverKeys(
      withConfigEntries(hardenedEnv, safeDirectoryEntries),
    );
    if (configuredDriverKeys === null) {
      return { code: 1, stdout: "", stderr: "could not enumerate configured merge drivers" };
    }
    const neutralizedDrivers: Array<[string, string]> = configuredDriverKeys.map((driverKey) => [
      driverKey,
      "false",
    ]);
    return this.run(["merge-tree", "--write-tree", base, head], {
      env: withConfigEntries(hardenedEnv, [
        ["merge.default", "text"],
        ["merge.renormalize", "false"],
        ["merge.union.driver", "false"],
        ...neutralizedDrivers,
        ...safeDirectoryEntries,
      ]),
      replacesInheritedEnv: true,
    });
  }

  treeOid(ref: string): string | null {
    return this.revParseRef(`${ref}^{tree}`);
  }

  push(remote: string, refspecs: string[], setUpstream: boolean): PushResult {
    const args = ["push", "--porcelain"];
    if (setUpstream) {
      args.push("-u");
    }
    const proc = this.run([...args, remote, ...refspecs]);
    return { ...proc, refs: parsePushPorcelain(proc.stdout) };
  }
}

function porcelainRefName(refspecText: string): string {
  const separator = refspecText.lastIndexOf(":");
  if (separator === -1) {
    return refspecText;
  }
  return refspecText.slice(separator + 1);
}

function porcelainStatus(flag: string): PushRefStatus {
  if (flag === "!") {
    return "rejected";
  }
  if (flag === "=") {
    return "up_to_date";
  }
  if (flag === " " || flag === "*") {
    return "ok";
  }
  return "error";
}

export function parsePushPorcelain(stdout: string): Record<string, PushRefResult> {
  const parsed: Record<string, PushRefResult> = {};
  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const flag = line.slice(0, 1);
    if (![" ", "*", "=", "!"].includes(flag)) {
      continue;
    }
    const parts = line.slice(1).split("\t").filter(Boolean);
    if (parts.length < 2) {
      continue;
    }
    const refName = porcelainRefName((parts[0] ?? "").trim());
    if (!refName) {
      continue;
    }
    parsed[refName] = {
      status: porcelainStatus(flag),
      summary: parts.slice(1).join("\t").trim(),
    };
  }
  return parsed;
}
