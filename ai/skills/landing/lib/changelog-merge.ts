const OURS_MARKER = "<<<<<<< ";
const BASE_MARKER = "||||||| ";
const SEPARATOR = "=======";
const THEIRS_MARKER = ">>>>>>> ";
const UNRELEASED_HEADING = /^## \[Unreleased\]/i;
const SECTION_HEADING = /^## /;
const BULLET_LINE = /^(\s*[-*] |\s+\S|\s*$)/;
const MARKER_SHAPED_LINE = /^([<|=>])\1{6,}( |$)/;

type ConflictHunk = { ours: string[]; base: string[]; theirs: string[]; nextIndex: number };

export function isChangelogPath(filePath: string): boolean {
  return filePath.split("/").at(-1) === "CHANGELOG.md";
}

function readHunk(lines: string[], openerIndex: number): ConflictHunk | null {
  const hunk: ConflictHunk = { ours: [], base: [], theirs: [], nextIndex: -1 };
  let part: string[] = hunk.ours;
  for (let index = openerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith(BASE_MARKER) && part === hunk.ours) {
      part = hunk.base;
      continue;
    }
    if (line === SEPARATOR && part === hunk.base) {
      part = hunk.theirs;
      continue;
    }
    if (line.startsWith(THEIRS_MARKER) && part === hunk.theirs) {
      hunk.nextIndex = index + 1;
      return hunk;
    }
    if (MARKER_SHAPED_LINE.test(line)) {
      return null;
    }
    part.push(line);
  }
  return null;
}

function addsOnlyBullets(hunk: ConflictHunk): boolean {
  return hunk.base.length === 0 && [...hunk.ours, ...hunk.theirs].every((line) => BULLET_LINE.test(line));
}

export function keepBothUnreleasedBullets(zdiff3Text: string): string | null {
  const lines = zdiff3Text.split("\n");
  const resolvedLines: string[] = [];
  let isInsideUnreleased = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith(OURS_MARKER)) {
      if (MARKER_SHAPED_LINE.test(line)) {
        return null;
      }
      if (SECTION_HEADING.test(line)) {
        isInsideUnreleased = UNRELEASED_HEADING.test(line);
      }
      resolvedLines.push(line);
      index += 1;
      continue;
    }
    const hunk = readHunk(lines, index);
    if (hunk === null || !isInsideUnreleased || !addsOnlyBullets(hunk)) {
      return null;
    }
    resolvedLines.push(...hunk.ours, ...hunk.theirs);
    index = hunk.nextIndex;
  }
  return resolvedLines.join("\n");
}
