import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AddedLinesScan, Git } from "./lib/git.ts";
import { repositoryGuard } from "./lib/guard.ts";
import {
  appendParkedEntry,
  dropParkedEntries,
  entryPathsAreAbsolute,
  type ParkedEntry,
} from "./lib/ledger.ts";
import { isCoherenceOnly, startJournalFollower, tracksCoherence } from "./lib/journal-follower.ts";
import { isTreeContained } from "./lib/merge-proof.ts";
import { normalizeMessage, validateMessage } from "./lib/message.ts";
import {
  branchForbidden,
  committed,
  denylistedFileStaged,
  emit,
  homePathStaged,
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
  isRefusedBeforeTransfer,
  type PendingPushRef,
  pushFailureText,
  refusalOutputText,
  sleep,
  statusByBranch,
} from "./lib/push.ts";
import { repoRequiresSignoff } from "./lib/signoff.ts";
import { readStdin } from "./lib/stdio.ts";
import {
  computeScope,
  findWorktreeForBranch,
  localPathMatches,
  isDenylisted,
  listedUsernames,
  localPathPrefixes,
  resolveMainline,
  withNewJournalFiles,
} from "./lib/workspace.ts";

const PUSH_ATTEMPTS = 3;
const NEVER_DELETED_BRANCHES = ["main", "master", "develop"];

type FailureOutcome =
  | "NOTHING_TO_COMMIT"
  | "DENYLISTED_FILE_STAGED"
  | "HOME_PATH_STAGED"
  | "HOOK_FAILED"
  | "PUSH_FAILED"
  | "PROMOTE_CONFLICT"
  | "PROMOTE_FAILED"
  | "MAINLINE_AHEAD"
  | "MAINLINE_UNVERIFIED";

type DetachedRebase =
  | { rebasedTip: string; failure: null }
  | { rebasedTip: null; failure: FailureOutcome };

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
  private homePathStagedLines: string[] = [];
  private conflicts: string[] = [];
  private localOnlyCommits: string[] = [];
  private mainline: string | null = null;
  private pushed = false;
  private commitHash: string | null = null;
  private deferredFeatureBranch: string | null = null;
  private parkedFeatureBranch: string | null = null;
  private preRebaseFeatureTip: string | null = null;
  private readOnlyHolderMainlineTip: string | null = null;
  private noOriginPromoteWarned = false;
  private scopePaths: string[] = [];

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

    const operatorScope = computeScope(this.git, this.config.paths);
    if (operatorScope.changed.size === 0 && operatorScope.untracked.length === 0) {
      return this.landNothing();
    }
    this.scopePaths = withNewJournalFiles(this.git, this.config.paths);
    const { untracked } = computeScope(this.git, this.scopePaths);

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

    this.followCoherenceJournal();

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

  private followCoherenceJournal(): void {
    if (this.config.noPush || isCoherenceOnly(this.config.paths) || !tracksCoherence(this.git)) {
      return;
    }
    startJournalFollower(this.git, this.config.promote);
    this.warnings.push("journal follower started: lands the next .coherence run journal within 30 minutes unless other files are uncommitted");
  }

  private landNothing(): Result {
    if (!this.config.promote) {
      const pushOutcome = this.pushFeatureBranch();
      if (pushOutcome) {
        return this.failure(pushOutcome);
      }
      return nothingToCommit({ pushed: this.pushed, warnings: this.warnings });
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
    if (outcome === "HOME_PATH_STAGED") {
      return homePathStaged({ matches: this.homePathStagedLines, warnings: this.warnings });
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
      this.git.addUpdate(this.scopePaths),
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

    // Check the index too: a pre-staged secret could reach origin in this same run.
    this.denylistedStagedFiles = this.git.stagedAdditions().filter(isDenylisted);
    if (this.denylistedStagedFiles.length > 0) {
      return "DENYLISTED_FILE_STAGED";
    }

    const commitMessage = normalizeMessage(message);
    const stagedScanOutcome = this.refuseLocalPaths(this.git.stagedAddedLines(), commitMessage);
    if (stagedScanOutcome) {
      return stagedScanOutcome;
    }

    const repositoryRoot = this.git.run(["rev-parse", "--show-toplevel"]);
    if (repositoryRoot.code !== 0) {
      this.warnings.push(repositoryRoot.stderr.trim());
      return "HOOK_FAILED";
    }
    const signoff = repoRequiresSignoff(repositoryRoot.stdout.trim());
    const headBeforeCommit = this.git.revParseHead();
    const proc = this.git.commit(commitMessage, { signoff });
    if (proc.code !== 0) {
      this.warnings.push(proc.stderr.trim());
      return "HOOK_FAILED";
    }

    const committedHash = this.git.revParseHead();
    if (committedHash === null) {
      this.warnings.push("commit succeeded but HEAD did not resolve to a commit");
      return "HOOK_FAILED";
    }

    const afterHooksScanOutcome = this.refuseLocalPaths(this.git.headAddedLines(), this.git.headMessage());
    if (afterHooksScanOutcome) {
      this.undoCommit(headBeforeCommit, committedHash);
      return afterHooksScanOutcome;
    }
    this.commitHash = committedHash;
    return null;
  }

  private refuseLocalPaths(addedLinesScan: AddedLinesScan, messageText: string | null): FailureOutcome | null {
    if (addedLinesScan.failure !== null) {
      this.warnings.push(`could not scan changes for local paths: ${addedLinesScan.failure}`);
      return "HOOK_FAILED";
    }
    if (messageText === null) {
      this.warnings.push("could not read the commit message to scan it for local paths");
      return "HOOK_FAILED";
    }
    const commitMessageLines = messageText.split("\n").map((text, index) => ({
      filePath: "commit message",
      lineNumber: index + 1,
      text,
    }));
    const localPrefixes = localPathPrefixes(os.homedir(), [os.userInfo().username, ...listedUsernames()]);
    this.homePathStagedLines = localPathMatches(
      [...addedLinesScan.addedLines, ...commitMessageLines],
      localPrefixes,
    );
    if (this.homePathStagedLines.length > 0) {
      return "HOME_PATH_STAGED";
    }
    return null;
  }

  private undoCommit(headBeforeCommit: string | null, committedHash: string): void {
    const undo = headBeforeCommit === null ? this.git.deleteHeadRef() : this.git.resetSoft(headBeforeCommit);
    if (undo.code !== 0) {
      this.warnings.push(`could not undo commit ${committedHash}: ${undo.stderr.trim()}`);
    }
  }

  private excludeStagedFilesOutsideScope(): FailureOutcome | null {
    if (this.scopePaths.length === 0) {
      return null;
    }
    const inScope = new Set(this.git.diffNameOnly({ cached: true, paths: this.scopePaths }));
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
    const branch = this.git.currentBranch();
    if (this.config.promote) {
      this.deferredFeatureBranch = branch;
      return null;
    }
    this.parkedFeatureBranch = branch;

    return this.pushFeatureRef(branch);
  }

  private pushFeatureRef(branch: string): FailureOutcome | null {
    const mainline = resolveMainline(this.git, configuredMainline(readCommitPolicy().policy));
    const mainlineBranchNames = mainline === null ? NEVER_DELETED_BRANCHES : [mainline, ...NEVER_DELETED_BRANCHES];
    const target = this.git.resolveFeaturePushTarget(branch, mainlineBranchNames);
    if (!this.git.listRemotes().includes(target.remote)) {
      this.warnings.push(`no ${target.remote} remote configured; skipping push`);
      return null;
    }
    const pending: PendingPushRef[] = [{ branch, kind: "feature", destination: target.destination }];
    if (this.refIsUpToDate(branch, target.trackingRef)) {
      this.markFeaturePushed(branch);
      return null;
    }

    const outcome = this.pushPendingRefs(pending, !target.hasUpstream, "PUSH_FAILED", target.remote);
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
    return this.pushFeatureRef(deferredBranch);
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

    const pushOutcome = this.pushFeatureRef(featureBranch);
    if (!pushOutcome) {
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
    const mainlineRef = this.readOnlyHolderMainlineTip === null ? `refs/heads/${mainline}` : `refs/remotes/origin/${mainline}`;
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
    const featureTipBeforeRebase = this.git.revParseHead();
    if (featureTipBeforeRebase === null) {
      this.warnings.push(
        `could not resolve HEAD before rebasing ${source} onto ${destination}; promotion stopped`,
      );
      return "PROMOTE_FAILED";
    }
    const rebaseBase = this.readOnlyHolderMainlineTip ?? destination;
    const rebase = this.rebaseInTemporaryWorktree(source, rebaseBase, featureTipBeforeRebase);
    if (rebase.failure !== null) {
      return rebase.failure;
    }
    const moveBranch = this.git.resetKeep(rebase.rebasedTip);
    if (moveBranch.code !== 0 && !this.carryUncommittedOnto(rebase.rebasedTip, featureTipBeforeRebase)) {
      const failureText = (moveBranch.stderr || moveBranch.stdout || "unknown error").trim();
      this.warnings.push(
        `could not move ${source} onto its rebase over ${destination} without overwriting uncommitted changes; promotion stopped: ${failureText}`,
      );
      return "PROMOTE_FAILED";
    }
    if (this.commitHash !== null) {
      this.commitHash = rebase.rebasedTip;
    }
    return this.fastForwardDestination(source, destination);
  }

  private carryUncommittedOnto(rebasedTip: string, featureTip: string): boolean {
    const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-snapshot-"));
    try {
      return this.carryUncommittedWith(rebasedTip, featureTip, path.join(scratchDirectory, "index"));
    } finally {
      fs.rmSync(scratchDirectory, { recursive: true, force: true });
    }
  }

  private carryUncommittedWith(rebasedTip: string, featureTip: string, scratchIndexPath: string): boolean {
    const uncommittedTree = this.git.workingTreeOid(scratchIndexPath);
    if (uncommittedTree === null) {
      return false;
    }
    const snapshot = this.git.commitTree(uncommittedTree, featureTip, "land.ts uncommitted snapshot");
    if (snapshot === null) {
      return false;
    }
    const rebasedTree = this.git.treeOid(rebasedTip);
    const rebasedOverFeature = rebasedTree === null ? null : this.git.commitTree(rebasedTree, featureTip, "land.ts rebased tree over the feature tip");
    if (rebasedOverFeature === null) {
      return false;
    }
    const merged = this.git.mergeTree(rebasedOverFeature, snapshot);
    if (merged.code !== 0) {
      return false;
    }
    const mergedTree = (merged.stdout.split("\n")[0] ?? "").trim();
    const mainlineChangedPaths = this.git.changedPathsBetween(uncommittedTree, mergedTree);
    if (mainlineChangedPaths === null) {
      return false;
    }
    if (this.git.workingTreeOid(scratchIndexPath) !== uncommittedTree) {
      return false;
    }
    if (this.git.resetMixed(rebasedTip).code !== 0) {
      return false;
    }
    if (mainlineChangedPaths.length > 0 && this.git.restoreWorkingTreeFrom(mergedTree, mainlineChangedPaths).code !== 0) {
      this.warnings.push(`the branch moved to ${rebasedTip} but mainline's changes to uncommitted files were not written; the uncommitted snapshot is ${snapshot}`);
      return true;
    }
    this.warnings.push("uncommitted changes outside --paths were carried onto the promoted branch and left unstaged");
    return true;
  }

  private rebaseInTemporaryWorktree(
    source: string,
    destination: string,
    featureTip: string,
  ): DetachedRebase {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-skill-rebase-"));
    const temporaryWorktree = path.join(temporaryDirectory, "worktree");
    try {
      return this.rebaseInWorktree(source, destination, featureTip, temporaryWorktree);
    } finally {
      this.discardTemporaryWorktree(temporaryDirectory, temporaryWorktree);
    }
  }

  private rebaseInWorktree(
    source: string,
    destination: string,
    featureTip: string,
    worktreePath: string,
  ): DetachedRebase {
    const addWorktree = this.git.addDetachedWorktree(worktreePath, featureTip);
    if (addWorktree.code !== 0) {
      this.warnings.push(
        `could not create a temporary worktree to rebase ${source} onto ${destination}; promotion stopped: ${addWorktree.stderr.trim()}`,
      );
      return { rebasedTip: null, failure: "PROMOTE_FAILED" };
    }
    const rebase = this.git.rebaseIn(worktreePath, destination);
    if (rebase.code !== 0) {
      const conflicts = this.git.conflictingFilesIn(worktreePath);
      this.git.rebaseAbortIn(worktreePath);
      if (conflicts.length > 0) {
        this.conflicts = conflicts;
        this.warnings.push(
          `rebase conflict promoting ${source} into ${destination}: ${conflicts.join(", ")}`,
        );
        return { rebasedTip: null, failure: "PROMOTE_CONFLICT" };
      }
      this.warnings.push(
        `could not rebase ${source} onto ${destination}; promotion stopped: ${rebase.stderr.trim()}`,
      );
      return { rebasedTip: null, failure: "PROMOTE_FAILED" };
    }
    const rebasedTip = this.git.revParseHeadIn(worktreePath);
    if (rebasedTip === null) {
      this.warnings.push(
        `could not resolve HEAD after rebasing ${source} onto ${destination}; promotion stopped`,
      );
      return { rebasedTip: null, failure: "PROMOTE_FAILED" };
    }
    return { rebasedTip, failure: null };
  }

  private discardTemporaryWorktree(temporaryDirectory: string, temporaryWorktree: string): void {
    const removal = this.git.removeWorktree(temporaryWorktree);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    if (removal.code === 0) {
      return;
    }
    this.git.pruneWorktrees();
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

    if (!this.isHolderWritable(holder, source, destination)) {
      return this.deferToReadOnlyHolder(source, destination, holder);
    }

    const statusBeforeMerge = this.git.statusShortIn(holder);
    const dirty = statusBeforeMerge.filter((line) => !line.startsWith("??"));
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
      this.reportPathsLeftByFailedMerge(holder, statusBeforeMerge);
      return "PROMOTE_FAILED";
    }

    this.warnings.push(`${destination} was fast-forwarded in its holding worktree: ${holder}`);
    return null;
  }

  // A guarded session can see a writable shared .git while the holder's working tree is read-only.
  // The tree can also be writable at its top and read-only below, and a partial merge leaves files behind.
  // A guarded session bind-mounts tracked files read-only one by one, so a writable directory can still hold an unreplaceable file.
  private isHolderWritable(holder: string, source: string, destination: string): boolean {
    const changedPaths = this.git.pathsChangedByFastForwardIn(holder, source);
    const indexPath = this.git.gitPathIn(holder, "index");
    const destinationRefPath = this.git.gitPathIn(holder, `refs/heads/${destination}`);
    const origHeadPath = this.git.gitPathIn(holder, "ORIG_HEAD");
    if (changedPaths === null || destinationRefPath === null || origHeadPath === null) {
      return false;
    }
    const pathsToWrite = indexPath !== null && fs.existsSync(indexPath) ? [holder, indexPath] : [holder];
    const gitDirectoriesToWrite = [destinationRefPath, origHeadPath].map((gitPath) =>
      nearestExistingDirectory(path.dirname(gitPath), holder),
    );
    const directoriesToWrite = changedPaths.map((changedPath) =>
      nearestExistingDirectory(path.join(holder, path.dirname(changedPath)), holder),
    );
    const existingFilesToWrite = changedPaths
      .map((changedPath) => path.join(holder, changedPath))
      .filter((changedFile) => fs.existsSync(changedFile));
    return [
      ...new Set([...pathsToWrite, ...gitDirectoriesToWrite, ...directoriesToWrite, ...existingFilesToWrite]),
    ].every(isWritable);
  }

  private reportPathsLeftByFailedMerge(holder: string, statusBeforeMerge: string[]): void {
    const statusBefore = new Set(statusBeforeMerge);
    const leftPaths = this.git.statusShortIn(holder).filter((line) => !statusBefore.has(line));
    if (leftPaths.length === 0) {
      return;
    }
    this.warnings.push(`left modified in ${holder}: ${leftPaths.map((line) => line.slice(3)).join(", ")}`);
  }

  private deferToReadOnlyHolder(source: string, destination: string, holder: string): FailureOutcome | null {
    if (this.config.noPush) {
      this.warnings.push(
        `${destination} is checked out read-only in ${holder} and --no-push forbids carrying the commit to origin/${destination}; promotion stopped`,
      );
      return "PROMOTE_FAILED";
    }
    if (!this.git.listRemotes().includes("origin")) {
      this.warnings.push(
        `${destination} is checked out read-only in ${holder} and no origin remote can carry the commit; promotion stopped`,
      );
      return "PROMOTE_FAILED";
    }
    const sourceTip = this.git.revParseRef(source);
    if (sourceTip === null) {
      this.warnings.push(`could not resolve ${source} to push it to origin/${destination}; promotion stopped`);
      return "PROMOTE_FAILED";
    }
    this.readOnlyHolderMainlineTip = sourceTip;
    this.warnings.push(
      `${destination} is checked out read-only in ${holder}; origin/${destination} moves without local ${destination}, which that checkout's owner fast-forwards`,
    );
    return null;
  }

  private refIsUpToDate(branch: string, trackingRef: string): boolean {
    const local = this.git.revParseRef(`refs/heads/${branch}`);
    if (local === null) {
      return false;
    }
    const remote = this.git.revParseRef(trackingRef);
    if (remote === null) {
      return false;
    }
    return local === remote;
  }

  private pushMainline(mainline: string): FailureOutcome | null {
    const heldBackTip = this.readOnlyHolderMainlineTip;
    if (heldBackTip !== null && this.git.revParseRef(`refs/remotes/origin/${mainline}`) === heldBackTip) {
      return null;
    }
    if (heldBackTip === null && this.refIsUpToDate(mainline, `refs/remotes/origin/${mainline}`)) {
      return null;
    }
    if (this.config.noPush) {
      this.warnings.push(`--no-push left ${mainline} unpushed after local promotion`);
      return null;
    }
    return this.pushPendingRefs(
      [{ branch: mainline, kind: "promote", sourceTip: heldBackTip ?? undefined }],
      false,
      "PROMOTE_FAILED",
    );
  }

  private pushPendingRefs(
    pendingRefs: PendingPushRef[],
    setUpstream: boolean,
    exhaustedOutcome: FailureOutcome,
    remote = "origin",
  ): FailureOutcome | null {
    if (pendingRefs.length === 0) {
      return null;
    }

    const refspecs = pendingRefs.map((pendingRef) => branchRefspec(pendingRef.branch, pendingRef.sourceTip, pendingRef.destination));
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      const push = this.git.push(remote, refspecs, setUpstream);
      const statuses = statusByBranch(push, pendingRefs);
      if (allRefsPushed(statuses)) {
        return null;
      }
      if (hasCauseFailure(statuses)) {
        for (const pendingRef of pendingRefs) {
          this.warnings.push(
            `${pushLabel(pendingRef)} failed: ${pushFailureText(push, pendingRef.branch, pendingRef.destination)}`,
          );
        }
        return exhaustedOutcome;
      }
      if (isRefusedBeforeTransfer(push)) {
        for (const pendingRef of pendingRefs) {
          this.warnings.push(
            `${pushLabel(pendingRef)} refused before reaching ${remote}, not retried: ${refusalOutputText(push)}`,
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

function pushLabel(pendingRef: PendingPushRef): string {
  return `${pendingRef.kind === "promote" ? "promote " : ""}push ${pendingRef.branch}`;
}

function nearestExistingDirectory(directory: string, holder: string): string {
  if (directory === holder || fs.existsSync(directory)) {
    return directory;
  }
  return nearestExistingDirectory(path.dirname(directory), holder);
}

function isWritable(pathToWrite: string): boolean {
  try {
    fs.accessSync(pathToWrite, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const config = parseArguments(process.argv.slice(2));
emit(new Landing(process.cwd(), config).run(await readStdin()));
