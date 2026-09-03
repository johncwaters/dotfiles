export function isPatchEquivalentMerged(cherryStdout: string): boolean {
  const cherryLines = cherryStdout.split("\n").filter((line) => line.trim() !== "");
  if (cherryLines.length === 0) {
    return false;
  }
  return cherryLines.every((line) => line.startsWith("-"));
}
