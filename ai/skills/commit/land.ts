import os from "node:os";
import { Git } from "./lib/git.ts";
import { repositoryGuard } from "./lib/guard.ts";
import {
  appendParkedEntry,
  dropParkedEntries,
  entryPathsAreAbsolute,
  type ParkedEntry,
} from "./lib/ledger.ts";
import { isTreeContained } from "./lib/merge-proof.ts";
import { normalizeMessage, validateMessage } from "./lib/message.ts";
import {
  branchForbidden,
  committed,
  denylistedFileStaged,
  emit,
  hookFailed,
  mainlineAhead,
  mainlineUnverified,
  messageInvalid,
  nothingToCommit,
  promoteConflict,
  promoteFailed,
  policyInvalid,
  pushFailed,
  type Result,
} from "./lib/outcome.ts";
import {
  configuredMainline,
  isBranchAllowed,
  policyValidationErrors,
  readCommitPolicy,
} from "./lib/policy.ts";
import {
  allRefsPushed,
  branchRefspec,
  hasCauseFailure,
  type PendingPushRef,
  pushFailureText,
  sleep,
  statusByBranch,
} from "./lib/push.ts";
import { readStdin } from "./lib/stdio.ts";
import {
  computeScope,
  findWorktreeForBranch,
  isDenylisted,
  resolveMainline,
} from "./lib/workspace.ts";

const PUSH_ATTEMPTS = 3;
const NEVER_DELETED_BRANCHES = ["main", "master", "develop"];

type FailureOutcome =
  | "NOTHING_TO_COMMIT"
  | "DENYLISTED_FILE_STAGED"
  | "HOOK_FAILED"
  | "PUSH_FAILED"
  | "PROMOTE_CONFLICT"
  | "PROMOTE_FAILED"
  | "MAINLINE_AHEAD"
  | "MAINLINE_UNVERIFIED";

const SAFETY_PUSH_OUTCOMES = new Set<FailureOutcome>([
  "PROMOTE_FAILED",
  "PROMOTE_CONFLICT",
  "MAINLINE_AHEAD",
  "MAINLINE_UNVERIFIED",
]);

const PARKED_OUTCOMES = new Set<FailureOutcome>([
  "PUSH_FAILED",
  "PROMOTE_CONFLICT",
  "PROMOTE_FAILED",
  "MAINLINE_AHEAD",
  "MAINLINE_UNVERIFIED",
]);

type Arguments = {
  paths: string[];
  promote: boolean;
  noPush: boolean;
  pushRetryDelayMs: number;
};

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    paths: [],
    promote: false,
    noPush: false,
    pushRetryDelayMs: 2000,
  };
  let collectingPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--paths") {
      collectingPaths = true;
      continue;
    }
    if (argument === "--promote") {
      parsed.promote = true;
      collectingPaths = false;
      continue;
    }
    if (argument === "--no-push") {
      parsed.noPush = true;
      collectingPaths = false;
      continue;
    }
    if (argument === "--push-retry-delay-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--push-retry-delay-ms takes a non-negative number");
      }
      parsed.pushRetryDelayMs = value;
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown flag ${argument}`);
    }
    if (!collectingPaths) {
      throw new Error(`unexpected argument ${argument}`);
    }
    parsed.paths.push(argument);
  }
  return parsed;
}

class Landing {
  private readonly git: Git;
  private readonly config: Arguments;
  private readonly warnings: string[] = [];
  private readonly promoted: string[] = [];
  private readonly deletedRemoteBranches: string[] = [];
  private denylistedStagedFiles: string[] = [];
  private conflicts: string[] = [];
  private localOnlyCommits: string[] = [];
  private mainline: string | null = null;
  private pushed = false;
  private commitHash: string | null = null;
  private deferredFeatureBranch: string | null = null;
  private parkedFeatureBranch: string | null = null;
  private preRebaseFeatureTip: string | null = null;
  private noOriginPromoteWarned = false;

  constructor(repo: string, config: Arguments) {
    this.git = new Git(repo);
    this.config = config;
  }

  run(message: string): Result {
    const guard = repositoryGuard(this.git);
    if (guard) {
      return guard;
    }

    const { policy, policyPath } = readCommitPolicy();
    const validationErrors = policyValidationErrors(policy, policyPath);
    if (validationErrors.length > 0) {
      return policyInvalid({ errors: validationErrors });
    }
    const branch = this.git.currentBranch();
    const mainline = resolveMainline(this.git, configuredMainline(policy));
    if (!isBranchAllowed(branch, policy, mainline)) {
      return branchForbidden({ branch });
    }

    const messageErrors = validateMessage(message);
    if (messageErrors.length > 0) {
      return messageInvalid({ errors: messageErrors });
    }

    const { changed, untracked } = computeScope(this.git, this.config.paths);
    if (changed.size === 0 && untracked.length === 0) {
      return this.landNothing();
    }

    const commitOutcome = this.commit(message, untracked);
    if (commitOutcome) {
      return this.failure(commitOutcome);
    }

    const pushOutcome = this.pushFeatureBranch();
    if (pushOutcome) {
      return this.failure(pushOutcome);
    }

    if (this.config.promote) {
      const promoteOutcome = this.promote();
      if (promoteOutcome) {
        return this.failure(promoteOutcome);
      }
    }

    return committed({
      commit: this.commitHash ?? "",
      pushed: this.pushed,
      promoted: this.promoted,
      ...(this.deletedRemoteBranches.length > 0
        ? { deletedRemoteBranches: this.deletedRemoteBranches }
        : {}),
      warnings: this.warnings,
    });
  }

  private landNothing(): Result {
    if (!this.config.promote) {
      return nothingToCommit({ warnings: this.warnings });
    }
    const promoteOutcome = this.promote();
    if (promoteOutcome) {
      return this.failure(promoteOutcome);
    }
    return nothingToCommit({
      pushed: this.pushed,
      promoted: this.promoted,
      ...(this.deletedRemoteBranches.length > 0
        ? { deletedRemoteBranches: this.deletedRemoteBranches }
        : {}),
      warnings: this.warnings,
    });
  }

  private failure(outcome: FailureOutcome): Result {
    this.recordParkedBranch(outcome);
    const state = {
      ...(this.commitHash ? { commit: this.commitHash } : {}),
      pushed: this.pushed,
      promoted: this.promoted,
      warnings: this.warnings,
    };
    if (outcome === "PUSH_FAILED") {
      return pushFailed(state);
    }
    if (outcome === "PROMOTE_CONFLICT") {
      return promoteConflict({ ...state, conflicts: this.conflicts });
    }
    if (outcome === "PROMOTE_FAILED") {
      return promoteFailed(state);
    }
    if (outcome === "MAINLINE_AHEAD") {
      return mainlineAhead({
        ...state,
        mainline: this.mainline ?? "",
        localOnlyCommits: this.localOnlyCommits,
      });
    }
    if (outcome === "MAINLINE_UNVERIFIED") {
      return mainlineUnverified({
        ...state,
        mainline: this.mainline ?? "",
      });
    }
    if (outcome === "NOTHING_TO_COMMIT") {
      return nothingToCommit({ pushed: this.pushed, promoted: this.promoted, warnings: this.warnings });
    }
    if (outcome === "DENYLISTED_FILE_STAGED") {
      return denylistedFileStaged({ files: this.denylistedStagedFiles, warnings: this.warnings });
    }
    return hookFailed({ warnings: this.warnings });
  }

  private recordParkedBranch(outcome: FailureOutcome): void {
    if (!PARKED_OUTCOMES.has(outcome) || this.parkedFeatureBranch === null) {
      return;
    }
    const entry: ParkedEntry = {
      v: 1,
      at: new Date().toISOString(),
      machine: os.hostname(),
      repo: this.git.repo,
      gitCommonDir: this.git.commonDir(),
      branch: this.parkedFeatureBranch,
      mainline: this.mainline,
      commit: this.commitHash ?? this.git.revParseHead() ?? "",
      outcome,
      pushed: this.pushed,
      conflicts: outcome === "PROMOTE_CONFLICT" ? this.conflicts : [],
    };
    if (!entryPathsAreAbsolute(entry)) {
      this.warnings.push("could not record parked branch in commit ledger");
      return;
    }
    if (!appendParkedEntry(entry)) {
      this.warnings.push("could not record parked branch in commit ledger");
    }
  }

  private clearParkedBranch(branch: string | null): void {
    if (branch === null || branch === "") {
      return;
    }
    const gitCommonDir = this.git.commonDir();
    if (gitCommonDir === "") {
      return;
    }
    dropParkedEntries({ gitCommonDir, branch });
  }

  private markFeaturePushed(branch: string): void {
    this.pushed = true;
    this.clearParkedBranch(branch);
  }

  private commit(message: string, untracked: string[]): FailureOutcome | null {
    const exclusionOutcome = this.excludeStagedFilesOutsideScope();
    if (exclusionOutcome) {
      return exclusionOutcome;
    }
    const stagingFailures = [
      this.git.addUpdate(this.config.paths),
      ...untracked.map((filePath) => this.git.addPath(filePath)),
    ].filter((staging) => staging.code !== 0);
    if (stagingFailures.length > 0) {
      for (const staging of stagingFailures) {
        this.warnings.push(`could not stage changes: ${staging.stderr.trim()}`);
      }
      return "HOOK_FAILED";
    }

    if (this.git.diffNameOnly({ cached: true }).length === 0) {
      return "NOTHING_TO_COMMIT";
    }

    // A denylisted path the scope filter never let in reached the index some other
    // way, and a new .env leaves for origin in the same run as the commit.
    this.denylistedStagedFiles = this.git.stagedAdditions().filter(isDenylisted);
    if (this.denylistedStagedFiles.length > 0) {
      return "DENYLISTED_FILE_STAGED";
    }

    const proc = this.git.commit(normalizeMessage(message));
    if (proc.code !== 0) {
      this.warnings.push(proc.stderr.trim());
      return "HOOK_FAILED";
    }

    const committedHash = this.git.revParseHead();
    if (committedHash === null) {
      this.warnings.push("commit succeeded but HEAD did not resolve to a commit");
      return "HOOK_FAILED";
    }
    this.commitHash = committedHash;
    return null;
  }

  private excludeStagedFilesOutsideScope(): FailureOutcome | null {
    if (this.config.paths.length === 0) {
      return null;
    }
    const inScope = new Set(this.git.diffNameOnly({ cached: true, paths: this.config.paths }));
    const outOfScope = this.git
      .diffNameOnly({ cached: true })
      .filter((filePath) => !inScope.has(filePath));
    if (outOfScope.length === 0) {
      return null;
    }
    const unstage = this.git.unstage(outOfScope);
    if (unstage.code !== 0) {
      this.warnings.push(`could not exclude staged files outside --paths: ${unstage.stderr.trim()}`);
      return "HOOK_FAILED";
    }
    this.warnings.push(`excluded staged files outside --paths: ${outOfScope.join(", ")}`);
    return null;
  }

  private pushFeatureBranch(): FailureOutcome | null {
    if (this.config.noPush) {
      return null;
    }
    if (!this.git.listRemotes().includes("origin")) {
      this.warnings.push("no origin remote configured; skipping push");
      return null;
    }

    const branch = this.git.currentBranch();
    if (this.config.promote) {
      this.deferredFeatureBranch = branch;
      return null;
    }
    this.parkedFeatureBranch = branch;

    const pending: PendingPushRef[] = [{ branch, kind: "feature" }];
    if (this.originRefIsUpToDate(branch)) {
      this.markFeaturePushed(branch);
      return null;
    }

    const outcome = this.pushPendingRefs(pending, !this.git.hasUpstream(), "PUSH_FAILED");
    if (outcome) {
      return outcome;
    }

    this.markFeaturePushed(branch);
    return null;
  }

  private promote(): FailureOutcome | null {
    const originExists = this.git.listRemotes().includes("origin");
    const { policy } = readCommitPolicy();
    const mainline = resolveMainline(this.git, configuredMainline(policy));
    this.mainline = mainline;
    const current = this.git.currentBranch();
    const featureBranch = this.featureBranchForPromotion(current, mainline);
    this.parkedFeatureBranch = featureBranch;
    if (mainline === null) {
      this.warnings.push("promotion skipped: no mainline");
      return this.pushDeferredFeatureBranch();
    }

    if (current === mainline) {
      this.warnings.push(`commit landed directly on ${mainline}; promotion skipped`);
      return null;
    }

    this.preRebaseFeatureTip = this.git.revParseRef("HEAD");
    if (originExists) {
      const syncOutcome = this.syncMainlineWithOrigin(mainline);
      if (syncOutcome) {
        this.pushFeatureAfterFailedMainlinePromotion(featureBranch, syncOutcome);
        return syncOutcome;
      }
    }

    const promoteOutcome = this.promoteHop(current, mainline);
    if (promoteOutcome) {
      this.pushFeatureAfterFailedMainlinePromotion(featureBranch, promoteOutcome);
      return promoteOutcome;
    }

    if (!originExists) {
      this.warnAboutMissingOrigin();
      this.promoted.push(mainline);
      this.clearParkedBranch(featureBranch);
      return null;
    }

    const pushOutcome = this.pushMainline(mainline);
    if (pushOutcome) {
      this.pushFeatureAfterFailedMainlinePromotion(featureBranch, pushOutcome);
      return pushOutcome;
    }

    this.promoted.push(mainline);
    this.clearParkedBranch(featureBranch);
    if (this.config.noPush) {
      return null;
    }
    this.deleteMergedRemoteFeatureBranch(featureBranch, mainline);
    return null;
  }

  private pushDeferredFeatureBranch(): FailureOutcome | null {
    const deferredBranch = this.deferredFeatureBranch;
    if (!deferredBranch || this.config.noPush) {
      return null;
    }
    if (!this.git.listRemotes().includes("origin")) {
      this.warnings.push("no origin remote configured; skipping push");
      return null;
    }
    const outcome = this.pushPendingRefs(
      [{ branch: deferredBranch, kind: "feature" }],
      !this.git.hasUpstream(),
      "PUSH_FAILED",
    );
    if (outcome) {
      return outcome;
    }
    this.markFeaturePushed(deferredBranch);
    return null;
  }

  private featureBranchForPromotion(current: string, mainline: string | null): string | null {
    if (this.deferredFeatureBranch) {
      return this.deferredFeatureBranch;
    }
    if (current === mainline) {
      return null;
    }
    return current;
  }

  private pushFeatureAfterFailedMainlinePromotion(
    featureBranch: string | null,
    outcome: FailureOutcome,
  ): void {
    if (!SAFETY_PUSH_OUTCOMES.has(outcome) || !featureBranch || this.config.noPush) {
      return;
    }

    const pushOutcome = this.pushPendingRefs(
      [{ branch: featureBranch, kind: "feature" }],
      false,
      "PUSH_FAILED",
    );
    if (!pushOutcome) {
      this.markFeaturePushed(featureBranch);
      return;
    }
    this.warnings.push(`promotion failed and safety push of ${featureBranch} also failed`);
  }

  private deleteMergedRemoteFeatureBranch(
    featureBranch: string | null,
    mainline: string | null,
  ): void {
    if (
      featureBranch === null ||
      featureBranch === mainline ||
      NEVER_DELETED_BRANCHES.includes(featureBranch)
    ) {
      return;
    }
    if (mainline === null || !this.promoted.includes(mainline)) {
      return;
    }

    if (this.git.fetchRemoteBranch("origin", featureBranch).code !== 0) {
      return;
    }

    const remoteFeatureRef = `refs/remotes/origin/${featureBranch}`;
    const remoteFeatureTip = this.git.revParseRef(remoteFeatureRef);
    if (remoteFeatureTip === null) {
      return;
    }
    const mainlineRef = `refs/heads/${mainline}`;
    const mainlineTip = this.git.revParseRef(mainlineRef);
    if (mainlineTip === null) {
      this.warnings.push(`could not verify merged remote branch ${featureBranch}: ${mainline} is unavailable`);
      return;
    }
    if (this.git.isAncestor(remoteFeatureTip, mainlineRef)) {
      this.pruneMergedRemoteBranch(featureBranch, remoteFeatureTip, mainline, mainlineTip);
      return;
    }

    const preRebaseTip = this.preRebaseFeatureTip;
    if (preRebaseTip === null || !this.git.isAncestor(remoteFeatureTip, preRebaseTip)) {
      this.warnings.push(
        `remote branch ${featureBranch} at ${remoteFeatureTip} carries commits this landing never rebased from ${preRebaseTip ?? "an unresolved head"}; keeping branch`,
      );
      return;
    }

    const mainlineTreeOid = this.git.treeOid(mainlineRef);
    if (mainlineTreeOid === null) {
      this.warnings.push(`could not verify merged remote branch ${featureBranch}: mainline tree is unavailable`);
      return;
    }
    const mergeTreeResult = this.git.mergeTree(mainlineRef, remoteFeatureTip);
    if (mergeTreeResult.code !== 0) {
      const failureText = (mergeTreeResult.stderr || "unknown error").trim();
      this.warnings.push(`could not verify merged remote branch ${featureBranch}: tree containment failed: ${failureText}`);
      return;
    }
    if (!isTreeContained(mergeTreeResult.stdout, mainlineTreeOid)) {
      this.warnings.push(`remote branch ${featureBranch} tree differs from ${mainline}; keeping branch`);
      return;
    }
    this.pruneMergedRemoteBranch(featureBranch, remoteFeatureTip, mainline, mainlineTip);
  }

  private pruneMergedRemoteBranch(
    featureBranch: string,
    remoteFeatureTip: string,
    mainline: string,
    pushedMainlineTip: string,
  ): void {
    const deletion = this.git.deleteRemoteBranch({
      remote: "origin",
      branch: featureBranch,
      expectedTip: remoteFeatureTip,
    });
    if (deletion.code !== 0) {
      const failureText = (deletion.stderr || deletion.stdout || "unknown error").trim();
      this.warnings.push(`could not delete merged remote branch ${featureBranch}: ${failureText}`);
      return;
    }

    const mainlineTipAfterDeletion = this.git.remoteBranchTip("origin", mainline);
    if (mainlineTipAfterDeletion === pushedMainlineTip) {
      this.deletedRemoteBranches.push(featureBranch);
      return;
    }
    this.restoreRemoteBranch(featureBranch, remoteFeatureTip, {
      mainline,
      pushedMainlineTip,
      mainlineTipAfterDeletion,
    });
  }

  private restoreRemoteBranch(
    featureBranch: string,
    remoteFeatureTip: string,
    mainlineState: {
      mainline: string;
      pushedMainlineTip: string;
      mainlineTipAfterDeletion: string | null;
    },
  ): void {
    const observedTip = mainlineState.mainlineTipAfterDeletion ?? "an unreadable head";
    this.warnings.push(
      `origin/${mainlineState.mainline} is at ${observedTip}, not the ${mainlineState.pushedMainlineTip} this landing pushed; restoring deleted remote branch ${featureBranch} at ${remoteFeatureTip}`,
    );
    const restore = this.git.push(
      "origin",
      [`${remoteFeatureTip}:refs/heads/${featureBranch}`],
      false,
    );
    if (restore.code === 0) {
      return;
    }
    const failureText = (restore.stderr || restore.stdout || "unknown error").trim();
    this.warnings.push(
      `could not restore deleted remote branch ${featureBranch} at ${remoteFeatureTip}: ${failureText}`,
    );
  }

  private promoteHop(source: string, destination: string): FailureOutcome | null {
    const rebase = this.git.rebase(destination);
    if (rebase.code !== 0) {
      const conflicts = this.git.conflictingFiles();
      this.git.rebaseAbort();
      if (conflicts.length > 0) {
        this.conflicts = conflicts;
        this.warnings.push(
          `rebase conflict promoting ${source} into ${destination}: ${conflicts.join(", ")}`,
        );
        return "PROMOTE_CONFLICT";
      }
      this.warnings.push(
        `could not rebase ${source} onto ${destination}; promotion stopped: ${rebase.stderr.trim()}`,
      );
      return "PROMOTE_FAILED";
    }
    if (this.commitHash !== null) {
      const rebasedHash = this.git.revParseHead();
      if (rebasedHash === null) {
        this.warnings.push(
          `could not resolve HEAD after rebasing ${source} onto ${destination}; promotion stopped`,
        );
        return "PROMOTE_FAILED";
      }
      this.commitHash = rebasedHash;
    }
    return this.fastForwardDestination(source, destination);
  }

  private warnAboutMissingOrigin(): void {
    if (this.noOriginPromoteWarned) {
      return;
    }
    this.warnings.push("no origin remote; promoted branches updated locally only");
    this.noOriginPromoteWarned = true;
  }

  private syncMainlineWithOrigin(mainline: string): FailureOutcome | null {
    const fetch = this.git.fetchRemoteBranch("origin", mainline);
    if (fetch.code !== 0) {
      this.warnings.push(
        `could not verify origin/${mainline}; fetch failed: ${fetch.stderr.trim()}`,
      );
      return "MAINLINE_UNVERIFIED";
    }

    const localRef = `refs/heads/${mainline}`;
    const remoteRef = `refs/remotes/origin/${mainline}`;
    const localTip = this.git.revParseRef(localRef);
    const remoteTip = this.git.revParseRef(remoteRef);
    if (remoteTip === null) {
      this.warnings.push(`could not verify origin/${mainline}; remote-tracking ref is missing`);
      return "MAINLINE_UNVERIFIED";
    }
    if (localTip === null) {
      const create = this.git.createTrackingBranch(mainline, `origin/${mainline}`);
      if (create.code === 0) {
        this.warnings.push(`materialized local ${mainline} from origin/${mainline}`);
        return null;
      }
      this.warnings.push(
        `could not materialize local ${mainline} from origin/${mainline}; promotion stopped: ${create.stderr.trim()}`,
      );
      return "PROMOTE_FAILED";
    }
    if (localTip === remoteTip) {
      return null;
    }
    if (this.git.isAncestor(localRef, remoteRef)) {
      return this.fastForwardDestination(remoteRef, mainline);
    }
    if (this.git.isAncestor(remoteRef, localRef)) {
      this.localOnlyCommits = this.git.revList(`${remoteRef}..${localRef}`);
      this.warnings.push(
        `local ${mainline} is ahead of origin/${mainline}; resolve local-only commits before promotion`,
      );
      return "MAINLINE_AHEAD";
    }
    this.warnings.push(`local ${mainline} has diverged from origin/${mainline}; promotion stopped`);
    return "PROMOTE_CONFLICT";
  }

  private fastForwardDestination(source: string, destination: string): FailureOutcome | null {
    const fastForward = this.git.fetchLocalFf(source, destination);
    if (fastForward.code === 0) {
      return null;
    }
    if (fastForward.stderr.includes("checked out")) {
      return this.fastForwardInHoldingWorktree(source, destination);
    }
    this.warnings.push(
      `could not fast-forward ${destination} from ${source}; promotion stopped: ${fastForward.stderr.trim()}`,
    );
    if (fastForward.stderr.includes("non-fast-forward") || fastForward.stderr.includes("rejected")) {
      return "PROMOTE_CONFLICT";
    }
    return "PROMOTE_FAILED";
  }

  private fastForwardInHoldingWorktree(source: string, destination: string): FailureOutcome | null {
    const worktrees = this.git.worktreeListPorcelain();
    const holder =
      worktrees.code === 0 ? findWorktreeForBranch(worktrees.stdout, destination) : null;

    if (holder === null) {
      this.warnings.push(
        `${destination} is checked out in another worktree but the holding worktree could not be found; promotion stopped`,
      );
      return "PROMOTE_FAILED";
    }

    const dirty = this.git.statusShortIn(holder).filter((line) => !line.startsWith("??"));
    if (dirty.length > 0) {
      this.warnings.push(
        `${destination} is checked out in ${holder} and has uncommitted changes; promotion stopped`,
      );
      return "PROMOTE_FAILED";
    }

    const merge = this.git.mergeFfOnlyIn(holder, source);
    if (merge.code !== 0) {
      this.warnings.push(
        `could not fast-forward ${destination} from ${source} in ${holder}; promotion stopped: ${merge.stderr.trim()}`,
      );
      return "PROMOTE_FAILED";
    }

    this.warnings.push(`${destination} was fast-forwarded in its holding worktree: ${holder}`);
    return null;
  }

  private originRefIsUpToDate(branch: string): boolean {
    const local = this.git.revParseRef(`refs/heads/${branch}`);
    if (local === null) {
      return false;
    }
    const remote = this.git.revParseRef(`refs/remotes/origin/${branch}`);
    if (remote === null) {
      return false;
    }
    return local === remote;
  }

  private pushMainline(mainline: string): FailureOutcome | null {
    if (this.originRefIsUpToDate(mainline)) {
      return null;
    }
    if (this.config.noPush) {
      this.warnings.push(`--no-push left ${mainline} unpushed after local promotion`);
      return null;
    }
    return this.pushPendingRefs(
      [{ branch: mainline, kind: "promote" }],
      false,
      "PROMOTE_FAILED",
    );
  }

  private pushPendingRefs(
    pendingRefs: PendingPushRef[],
    setUpstream: boolean,
    exhaustedOutcome: FailureOutcome,
  ): FailureOutcome | null {
    if (pendingRefs.length === 0) {
      return null;
    }

    const refspecs = pendingRefs.map((pendingRef) => branchRefspec(pendingRef.branch));
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      const push = this.git.push("origin", refspecs, setUpstream);
      const statuses = statusByBranch(push, pendingRefs);
      if (allRefsPushed(statuses)) {
        return null;
      }
      if (hasCauseFailure(statuses)) {
        for (const pendingRef of pendingRefs) {
          this.warnings.push(
            `${pendingRef.kind === "promote" ? "promote " : ""}push ${pendingRef.branch} failed: ${pushFailureText(push, pendingRef.branch)}`,
          );
        }
        return exhaustedOutcome;
      }

      this.appendBatchTransportWarnings(pendingRefs, attempt, push.stderr.trim());
      if (attempt === PUSH_ATTEMPTS) {
        break;
      }
      sleep(this.config.pushRetryDelayMs);
    }
    return exhaustedOutcome;
  }

  private appendBatchTransportWarnings(
    pendingRefs: PendingPushRef[],
    attempt: number,
    stderr: string,
  ): void {
    for (const pendingRef of pendingRefs) {
      if (pendingRef.kind === "feature") {
        this.warnings.push(`push attempt ${attempt}/${PUSH_ATTEMPTS} failed: ${stderr}`);
        continue;
      }
      this.warnings.push(
        `promote push ${pendingRef.branch} attempt ${attempt}/${PUSH_ATTEMPTS} failed: ${stderr}`,
      );
    }
  }
}

const config = parseArguments(process.argv.slice(2));
emit(new Landing(process.cwd(), config).run(await readStdin()));
