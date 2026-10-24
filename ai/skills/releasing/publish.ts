import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Git, parsePushPorcelain, type PushRefResult } from "../committing/lib/git.ts";
import { branchRefspec } from "../committing/lib/push.ts";
import { emit } from "./outcome.ts";

const REMOTE_QUERY_TIMEOUT_MS = 30000;

type ReleaseProfile = { releaseFrom: string; integration?: string; tagFormat: string };

function parseCommandLine(): { tag: string; branches: string[]; remote: string } {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: "string" },
        branch: { type: "string", multiple: true },
        remote: { type: "string", default: "origin" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.tag) {
      emit("ARGS_INVALID", { reason: "--tag is required" });
    }
    return { tag: values.tag, branches: [...new Set(values.branch ?? [])], remote: values.remote };
  } catch (parseError) {
    return emit("ARGS_INVALID", { reason: (parseError as Error).message });
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readReleaseProfile(repoRoot: string): ReleaseProfile {
  const profilePath = path.join(repoRoot, ".claude", "release-profile.json");
  let profile: { git?: Record<string, unknown>; versioning?: Record<string, unknown> };
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (readError) {
    return emit("PROFILE_INVALID", { profilePath, reason: (readError as Error).message });
  }
  const releaseFrom = nonEmptyString(profile.git?.release_from);
  const tagFormat = nonEmptyString(profile.versioning?.tag_format);
  if (!releaseFrom || !tagFormat) {
    emit("PROFILE_INVALID", { profilePath, reason: "git.release_from and versioning.tag_format are required" });
  }
  return { releaseFrom, integration: nonEmptyString(profile.git?.integration), tagFormat };
}

function tagFormatPattern(tagFormat: string): RegExp {
  const escapedFormat = tagFormat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedFormat.replace(/[XYZ]/g, "(?:0|[1-9]\\d*)")}$`);
}

function checkBranches(git: Git, branches: string[], profile: ReleaseProfile): void {
  const allowedBranches = [profile.releaseFrom, profile.integration].filter((branch) => branch !== undefined);
  for (const branch of branches) {
    if (!allowedBranches.includes(branch)) {
      emit("BRANCH_NOT_ALLOWED", { branch, allowedBranches });
    }
    if (!git.verifyRef(`refs/heads/${branch}`)) {
      emit("ARGS_INVALID", { reason: `no local branch ${branch}` });
    }
  }
}

function checkTag(git: Git, tag: string, profile: ReleaseProfile): string {
  if (!tagFormatPattern(profile.tagFormat).test(tag)) {
    emit("TAG_INVALID", { tag, reason: `name does not match tag_format ${profile.tagFormat}` });
  }
  const tagObjectType = git.run(["cat-file", "-t", `refs/tags/${tag}`]);
  if (tagObjectType.code !== 0) {
    emit("TAG_INVALID", { tag, reason: "no local tag" });
  }
  if (tagObjectType.stdout.trim() !== "tag") {
    emit("TAG_INVALID", { tag, reason: "tag is lightweight, not annotated" });
  }
  const taggedCommit = git.revParseRef(`refs/tags/${tag}^{commit}`);
  if (!taggedCommit) {
    emit("TAG_INVALID", { tag, reason: "tag does not point at a commit" });
  }
  return taggedCommit;
}

function releaseTipAfterPush(git: Git, remote: string, branches: string[], profile: ReleaseProfile): string | null {
  if (branches.includes(profile.releaseFrom)) {
    return git.revParseRef(`refs/heads/${profile.releaseFrom}`);
  }
  return exactRemoteBranchTip(git, remote, profile.releaseFrom);
}

function exactRemoteBranchTip(git: Git, remote: string, branch: string): string | null {
  const branchRef = `refs/heads/${branch}`;
  const listing = git.run(["ls-remote", "--heads", remote, branchRef], {
    noPrompt: true,
    timeoutMs: REMOTE_QUERY_TIMEOUT_MS,
  });
  if (listing.code !== 0) {
    return null;
  }
  const matchingLine = listing.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, listedRef]) => listedRef?.trim() === branchRef);
  return matchingLine?.[0]?.trim() || null;
}

function main(): void {
  const { tag, branches, remote } = parseCommandLine();
  const repoRoot = new Git(process.cwd()).run(["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!repoRoot) {
    emit("ARGS_INVALID", { reason: "not inside a git work tree" });
  }
  const git = new Git(repoRoot);
  if (!git.listRemotes().includes(remote)) {
    emit("ARGS_INVALID", { reason: `no remote named ${remote}` });
  }
  const profile = readReleaseProfile(repoRoot);
  checkBranches(git, branches, profile);
  const taggedCommit = checkTag(git, tag, profile);
  const releaseTip = releaseTipAfterPush(git, remote, branches, profile);
  if (taggedCommit !== releaseTip) {
    emit("TAG_NOT_ON_RELEASE_TIP", { tag, taggedCommit, releaseFrom: profile.releaseFrom, releaseTip });
  }

  const tagRef = `refs/tags/${tag}`;
  const pushedRefs = [...branches.map((branch) => `refs/heads/${branch}`), tagRef];
  const refspecs = [...branches.map((branch) => branchRefspec(branch)), `${tagRef}:${tagRef}`];
  const pushArgs = ["push", "--porcelain", "--atomic", "--no-follow-tags", "--recurse-submodules=no", remote];
  const push = git.run([...pushArgs, ...refspecs], { noPrompt: true });
  const reportedRefs = parsePushPorcelain(push.stdout);
  const unrequestedRefs = Object.keys(reportedRefs).filter((reportedRef) => !pushedRefs.includes(reportedRef));
  if (unrequestedRefs.length > 0) {
    emit("PUSH_FAILED", { remote, refs: reportedRefs, unrequestedRefs, detail: push.stderr.trim() });
  }
  const refs: Record<string, PushRefResult> = {};
  for (const pushedRef of pushedRefs) {
    refs[pushedRef] = reportedRefs[pushedRef] ?? { status: push.code === 0 ? "ok" : "unknown", summary: "" };
  }
  const statuses = Object.values(refs).map((ref) => ref.status);
  if (statuses.every((status) => status === "ok" || status === "up_to_date")) {
    emit("PUBLISHED", { remote, refs });
  }
  const detail = push.stderr.trim();
  if (statuses.includes("rejected")) {
    emit("PUSH_REJECTED", { remote, refs, detail });
  }
  emit("PUSH_FAILED", { remote, refs, detail });
}

main();
