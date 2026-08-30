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
import { computeScope, resolveMainline } from "./lib/workspace.ts";

type Arguments = { paths: string[]; checkMessage: boolean };

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { paths: [], checkMessage: false };
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

function releaseProfileIntegration(repo: string): string | null {
  const profilePath = path.join(repo, ".claude", "release-profile.yml");
  if (!fs.existsSync(profilePath)) {
    return null;
  }
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
      return null;
    }
    const match = /^integration:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(content);
    const integration = match?.[1];
    if (integration === "null" || integration === "~") {
      return null;
    }
    if (integration) {
      return integration;
    }
  }
  return null;
}

function preflightResult(paths: string[]): Result {
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
  if (policy && mainline === null) {
    warnings.push("could not resolve the policy mainline; promotion will be skipped");
  }
  const releaseIntegration = releaseProfileIntegration(process.cwd());
  if (mainline !== null && releaseIntegration !== null && releaseIntegration !== mainline) {
    warnings.push(
      `.claude/release-profile.yml git.integration names ${releaseIntegration}, but commit policy resolves mainline to ${mainline}`,
    );
  }
  const resolvedPolicy = policy ? { ...policy, resolved: { mainline } } : undefined;

  return {
    ...ready({
      branch,
      branchAllowed: isBranchAllowed(branch, policy),
      changed: [...changed].sort(),
      untracked,
      ...(profile ? { profile } : {}),
      ...(resolvedPolicy ? { policy: resolvedPolicy } : {}),
      warnings,
    }),
    paths: resolvedScopePaths,
  };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.checkMessage) {
  emit(checkMessageResult(await readStdin()));
}
emit(preflightResult(parsed.paths));
