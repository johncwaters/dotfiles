export const protectedPaths = [
  { path: "~/.ssh", kind: "directory" },
  { path: "~/.gnupg", kind: "directory" },
  { path: "~/.aws", kind: "directory" },
  { path: "~/.kube", kind: "directory" },
  { path: "~/.docker", kind: "directory" },
  { path: "~/.netrc", kind: "file" },
  { path: "~/.git-credentials", kind: "file" },
  { path: "~/.config/gh", kind: "directory" },
  { path: "~/.claude/.credentials.json", kind: "file" },
  { path: "~/.glimmervoid/config.json*", kind: "file" },
  { path: "~/.glimmervoid/secrets.env", kind: "file" },
  { path: "~/.npmrc", kind: "file" },
  { path: "~/.azure", kind: "directory" },
  { path: "~/.local/share/keyrings", kind: "directory" },
  { path: "~/.mozilla", kind: "directory" },
  { path: "~/.config/google-chrome", kind: "directory" },
  { path: "~/.config/chromium", kind: "directory" },
  { path: "~/.pki", kind: "directory" },
];

export function buildClaudeProtectedReadRules() {
  return protectedPaths.map((protectedPath) => `Read(${protectedPath.path}${protectedPath.kind === "directory" ? "/**" : ""})`);
}

