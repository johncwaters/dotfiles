import type { PushRefResult, PushResult } from "./git.ts";

export type PendingPushRef = { branch: string; kind: "feature" | "promote" };

export function sleep(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function branchRefspec(branch: string): string {
  return `refs/heads/${branch}:refs/heads/${branch}`;
}

function pushRefResult(push: PushResult, branch: string): PushRefResult | undefined {
  return push.refs[`refs/heads/${branch}`] ?? push.refs[branch];
}

export function statusByBranch(
  push: PushResult,
  pendingRefs: PendingPushRef[],
): Record<string, PushRefResult> {
  const statuses: Record<string, PushRefResult> = {};
  for (const pendingRef of pendingRefs) {
    const parsed = pushRefResult(push, pendingRef.branch);
    if (parsed) {
      statuses[pendingRef.branch] = parsed;
      continue;
    }
    statuses[pendingRef.branch] = {
      status: push.code === 0 ? "ok" : "unknown",
      summary: "",
    };
  }
  return statuses;
}

function isCauseFailure(entry: PushRefResult | undefined): boolean {
  return entry?.status === "rejected" || entry?.status === "error";
}

export function allRefsPushed(statuses: Record<string, PushRefResult>): boolean {
  return Object.values(statuses).every(
    (entry) => entry.status === "ok" || entry.status === "up_to_date",
  );
}

export function hasCauseFailure(statuses: Record<string, PushRefResult>): boolean {
  return Object.values(statuses).some((entry) => isCauseFailure(entry));
}

export function pushFailureText(push: PushResult, branch: string): string {
  const parsed = pushRefResult(push, branch);
  const stderr = push.stderr.trim();
  if (parsed?.summary && stderr) {
    return `${parsed.summary}: ${stderr}`;
  }
  if (parsed?.summary) {
    return parsed.summary;
  }
  if (stderr) {
    return stderr;
  }
  return push.stdout.trim();
}
