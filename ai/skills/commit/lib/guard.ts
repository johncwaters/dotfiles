import type { Git } from "./git.ts";
import { detachedHead, notARepo, operationInProgress, type Result } from "./outcome.ts";

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"] as const;

// preflight and land share this guard so neither refuses what the other would land.
export function repositoryGuard(git: Git): Result | null {
  if (!git.isInsideWorkTree()) {
    return notARepo({});
  }
  if (git.currentBranch() === "HEAD") {
    return detachedHead({});
  }
  for (const marker of IN_PROGRESS_MARKERS) {
    if (git.verifyRef(marker)) {
      return operationInProgress({ operation: marker });
    }
  }
  return null;
}
