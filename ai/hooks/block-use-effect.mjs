import path from "node:path";
import { runGrowthGuard } from "./edit-judge.mjs";
import { useEffectSyntaxFor, scanUseEffectLines } from "./comment-scanner.mjs";
import { denyPreToolUse } from "./hook-io.mjs";

function deny(filePath, addedCount, samples) {
  const shown = samples.slice(0, 3).map((line) => `  ${line.trim().slice(0, 100)}`);
  denyPreToolUse([
    `No-useEffect guard blocked this write to ${path.basename(filePath)}.`,
    `Why: it adds ${addedCount} net-new useEffect or useLayoutEffect call(s):`,
    ...shown,
    "Fix: compute derived values during render (useMemo only if measured slow); run side effects in the event handler that causes them; fetch through the app's data layer or loader; subscribe to external stores with useSyncExternalStore; reset state with a key.",
    "Existing calls are not counted; there is no escape comment.",
  ].join("\n"));
}

runGrowthGuard({ syntaxFor: useEffectSyntaxFor, scanLines: scanUseEffectLines, deny });
