import fs from "node:fs";
import path from "node:path";
import { Git } from "./lib/git.ts";
import { repositoryGuard } from "./lib/guard.ts";
import { validateMessage } from "./lib/message.ts";
import {
  emit,
  messageInvalid,
  messageValid,
  policyInvalid,
  ready,
  type Result,
} from "./lib/outcome.ts";
import {
  configuredMainline,
  isBranchAllowed,
  policyValidationErrors,
  readCommitPolicy,
} from "./lib/policy.ts";
import { readStdin } from "./lib/stdio.ts";
import { readGithubRemote, readRemoteVisibility, resolveAfterCommit } from "./lib/visibility.ts";
import { checkMainlineFreshness, computeScope, resolveMainline } from "./lib/workspace.ts";

type Arguments = { paths: string[]; checkMessage: boolean; noFetch: boolean };

type ReleaseIntegrationLookup = {
  profilePath?: string;
  integration?: string;
  warning?: string;
};

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { paths: [], checkMessage: false, noFetch: false };
  let collectingPaths = false;
  for (const argument of argv) {
    if (argument === "--check-message") {
      parsed.checkMessage = true;
      collectingPaths = false;
      continue;
    }
    if (argument === "--paths") {
      collectingPaths = true;
      continue;
    }
    if (argument === "--no-fetch") {
      parsed.noFetch = true;
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

function checkMessageResult(message: string): Result {
  const errors = validateMessage(message);
  if (errors.length > 0) {
    return messageInvalid({ errors });
  }
  return messageValid({});
}

function jsonReleaseProfileIntegration(profilePath: string): ReleaseIntegrationLookup {
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    const git = profile.git as Record<string, unknown> | undefined;
    const integration = git?.integration;
    if (typeof integration !== "string") {
      return {};
    }
    return { profilePath, integration };
  } catch (error) {
    return { warning: `could not parse ${profilePath} while checking git.integration: ${String(error)}` };
  }
}

function yamlReleaseProfileIntegration(profilePath: string): ReleaseIntegrationLookup {
  const lines = fs.readFileSync(profilePath, "utf8").split(/\r?\n/);
  let gitIndent: number | null = null;
  for (const line of lines) {
    const content = line.trim();
    const indent = line.length - line.trimStart().length;
    if (gitIndent === null && content === "git:") {
      gitIndent = indent;
      continue;
    }
    if (gitIndent === null) {
      continue;
    }
    if (content !== "" && indent <= gitIndent) {
      return {};
    }
    const match = /^integration:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(content);
    const integration = match?.[1];
    if (integration === "null" || integration === "~") {
      return {};
    }
    if (integration) {
      return { profilePath, integration };
    }
  }
  return {};
}

function releaseProfileIntegration(repo: string): ReleaseIntegrationLookup {
  const jsonProfilePath = path.join(repo, ".claude", "release-profile.json");
  if (fs.existsSync(jsonProfilePath)) {
    return jsonReleaseProfileIntegration(jsonProfilePath);
  }

  const profilePath = path.join(repo, ".claude", "release-profile.yml");
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  return yamlReleaseProfileIntegration(profilePath);
}

function preflightResult(paths: string[], noFetch: boolean): Result {
  const git = new Git(process.cwd());
  const guard = repositoryGuard(git);
  if (guard) {
    return guard;
  }

  const branch = git.currentBranch();
  const { changed, untracked } = computeScope(git, paths);
  const resolvedScopePaths = [...new Set([...changed, ...untracked])].sort();
  const { profile, policy, policyPath, warning } = readCommitPolicy();
  const validationErrors = policyValidationErrors(policy, policyPath);
  if (validationErrors.length > 0) {
    return policyInvalid({ errors: validationErrors });
  }

  const mainline = resolveMainline(git, configuredMainline(policy));
  const warnings = warning ? [warning] : [];
  const origin = readGithubRemote(git);
  const ownershipResolution = resolveAfterCommit(origin);
  const resolvedPolicy = policy ? { ...policy, afterCommit: ownershipResolution.mode, resolved: { mainline } } : undefined;
  if (ownershipResolution.warning) {
    warnings.push(ownershipResolution.warning);
  }
  const mainlineFreshness = mainline === null || noFetch
    ? undefined
    : checkMainlineFreshness(git, mainline);
  if (mainlineFreshness?.checked && mainlineFreshness.behind > 0) {
    const shouldMergeMainline = resolvedPolicy?.afterCommit === "pull-request" && git.hasUpstream();
    const integrationVerb = shouldMergeMainline ? "merge" : "rebase onto";
    warnings.push(
      `branch is ${mainlineFreshness.behind} commits behind origin/${mainlineFreshness.mainline}; ${integrationVerb} origin/${mainlineFreshness.mainline} before review`,
    );
  }
  if (policy && mainline === null) {
    warnings.push("could not resolve the policy mainline; promotion will be skipped");
  }
  const releaseIntegration = releaseProfileIntegration(process.cwd());
  if (releaseIntegration.warning) {
    warnings.push(releaseIntegration.warning);
  }
  if (
    mainline !== null &&
    releaseIntegration.integration !== undefined &&
    releaseIntegration.integration !== mainline
  ) {
    const profilePath = (releaseIntegration.profilePath ?? "").replace(`${process.cwd()}/`, "");
    warnings.push(
      `${profilePath} git.integration names ${releaseIntegration.integration}, but commit policy resolves mainline to ${mainline}`,
    );
  }

  return {
    ...ready({
      branch,
      branchAllowed: isBranchAllowed(branch, policy, mainline),
      changed: [...changed].sort(),
      untracked,
      ...(profile ? { profile } : {}),
      ...(resolvedPolicy ? { policy: resolvedPolicy } : {}),
      ...(mainlineFreshness ? { mainlineFreshness } : {}),
      remoteVisibility: readRemoteVisibility(origin),
      warnings,
    }),
    paths: resolvedScopePaths,
  };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.checkMessage) {
  emit(checkMessageResult(await readStdin()));
}
emit(preflightResult(parsed.paths, parsed.noFetch));
