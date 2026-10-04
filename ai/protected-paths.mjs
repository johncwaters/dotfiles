export const protectedPaths = [
  { path: "~/.ssh", kind: "directory", scope: "both" },
  { path: "~/.gnupg", kind: "directory", scope: "both" },
  { path: "~/.aws", kind: "directory", scope: "both" },
  { path: "~/.kube", kind: "directory", scope: "both" },
  { path: "~/.docker", kind: "directory", scope: "both" },
  { path: "~/.netrc", kind: "file", scope: "both" },
  { path: "~/.git-credentials", kind: "file", scope: "both" },
  { path: "~/.config/gh", kind: "directory", scope: "both" },
  {
    path: "~/.codex/auth.json",
    kind: "file",
    scope: "codex",
    reason: "Claude's Bash sandbox must let Codex read its login file (fa25be3).",
  },
  { path: "~/.claude/.credentials.json", kind: "file", scope: "both" },
  { path: "~/.glimmervoid/config.json*", kind: "file", scope: "both" },
  { path: "~/.glimmervoid/secrets.env", kind: "file", scope: "both" },
  { path: "~/.npmrc", kind: "file", scope: "both" },
  { path: "~/.azure", kind: "directory", scope: "both" },
  { path: "~/.local/share/keyrings", kind: "directory", scope: "both" },
  { path: "~/.mozilla", kind: "directory", scope: "both" },
  { path: "~/.config/google-chrome", kind: "directory", scope: "both" },
  { path: "~/.config/chromium", kind: "directory", scope: "both" },
  { path: "~/.pki", kind: "directory", scope: "both" },
];

export function buildClaudeProtectedReadRules() {
  return protectedPaths
    .filter((protectedPath) => protectedPath.scope === "both")
    .map((protectedPath) => `Read(${protectedPath.path}${protectedPath.kind === "directory" ? "/**" : ""})`);
}

export function buildCodexReviewSandboxProfile() {
  const filesystemRules = protectedPaths
    .map((protectedPath) => `"${protectedPath.path}"="deny"`)
    .join(", ");
  return `'permissions.qa_review={extends=":read-only", filesystem={${filesystemRules}}}'`;
}
