import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A machine with no applied profile still must not commit onto a mainline branch,
// so the guard falls back to the strictest rule every profile shares.
const FALLBACK_FORBIDDEN_BRANCHES = ["main", "master"] as const;

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type CommitPolicy = Record<string, unknown>;

export type PolicyLookup = {
  profile?: string;
  policy?: CommitPolicy;
  policyPath?: string;
  warning?: string;
};

export function claudeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function policyRoot(): string {
  return process.env.CLAUDE_COMMIT_POLICY_ROOT ?? claudeRoot();
}

export function readCommitPolicy(root: string = policyRoot()): PolicyLookup {
  const markerPath = path.join(root, ".machine-profile");
  if (!fs.existsSync(markerPath)) {
    return { warning: `no machine profile marker at ${markerPath}; run setup/apply to write one` };
  }

  const profile = fs.readFileSync(markerPath, "utf8").trim().toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    return { warning: `machine profile marker names no usable profile: ${JSON.stringify(profile)}` };
  }

  const policyPath = path.join(root, "profiles", profile, "commit-policy.json");
  if (!fs.existsSync(policyPath)) {
    return { profile, policyPath, warning: `no commit policy at ${policyPath}` };
  }

  try {
    return {
      profile,
      policyPath,
      policy: JSON.parse(fs.readFileSync(policyPath, "utf8")) as CommitPolicy,
    };
  } catch (error) {
    return { profile, policyPath, warning: `could not parse ${policyPath}: ${String(error)}` };
  }
}

export function configuredMainline(policy: CommitPolicy | undefined): unknown {
  return policy?.mainline ?? "auto";
}

export function policyValidationErrors(
  policy: CommitPolicy | undefined,
  policyPath: string | undefined,
): string[] {
  if (!policy) {
    return [];
  }
  const commitBranches = policy.commitBranches as { onForbidden?: unknown } | undefined;
  const onForbidden = commitBranches?.onForbidden;
  if (onForbidden === undefined || typeof onForbidden !== "string") {
    return [];
  }
  if (onForbidden === "create-feature-branch") {
    return [];
  }
  const source = policyPath ?? "commit-policy.json";
  return [
    `${source} commitBranches.onForbidden must be "create-feature-branch", got ${JSON.stringify(onForbidden)}`,
  ];
}

export function forbiddenBranches(policy: CommitPolicy | undefined): string[] {
  const commitBranches = policy?.commitBranches as { forbid?: unknown } | undefined;
  const forbid = commitBranches?.forbid;
  if (!Array.isArray(forbid)) {
    return [...FALLBACK_FORBIDDEN_BRANCHES];
  }
  return forbid.filter((entry): entry is string => typeof entry === "string");
}

export function isBranchAllowed(branch: string, policy: CommitPolicy | undefined): boolean {
  return !forbiddenBranches(policy).includes(branch);
}
