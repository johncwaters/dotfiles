#!/usr/bin/env bash
# Runs a destructive suite against a throwaway $HOME, /tmp and /var/tmp, in its own pid,
# ipc and uts namespaces. The rest of what it can see is read only or absent, so a topic
# that converges a machine cannot converge this one. Bubblewrap rather than a container
# runtime, because it needs no daemon, no root and no image pull.

set -euo pipefail

selfDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$selfDirectory/.." && pwd)"
claudeSetupRepo="${CLAUDE_SETUP_REPO:-$HOME/Projects/claude-setup}"

if ! command -v bwrap >/dev/null 2>&1; then
  printf 'run-sandbox: bubblewrap (bwrap) is not installed.\n' >&2
  exit 1
fi

if (($# == 0)); then
  printf 'Usage: test/run-sandbox.sh <command> [args...]\n' >&2
  exit 1
fi

# A shared pid namespace would let the suite reach the live home through /proc/<pid>/root
# and signal the process running it, so the mounts alone are not the isolation.
sandboxArguments=(
  --unshare-pid
  --unshare-ipc
  --unshare-uts
  --proc /proc
  --dev /dev
  --ro-bind /usr /usr
  --ro-bind /etc /etc
  --tmpfs /tmp
  --tmpfs /var/tmp
)

bindRootEntry() {
  local rootPath="$1"
  if [[ -L "$rootPath" ]]; then
    sandboxArguments+=(--symlink "$(readlink -- "$rootPath")" "$rootPath")
    return 0
  fi
  if [[ -d "$rootPath" ]]; then
    sandboxArguments+=(--ro-bind "$rootPath" "$rootPath")
  fi
}

for rootEntry in /bin /sbin /lib /lib32 /lib64 /libx32 /opt /nix; do
  bindRootEntry "$rootEntry"
done

sandboxArguments+=(
  --tmpfs "$HOME"
  --ro-bind "$repoRoot" "$repoRoot"
  --setenv DOTFILES_SANDBOX 1
  --setenv DOTFILES_REPO_UNDER_TEST "$repoRoot"
)

if [[ -d "$claudeSetupRepo" ]]; then
  sandboxArguments+=(--ro-bind "$claudeSetupRepo" "$claudeSetupRepo")
  sandboxArguments+=(--setenv CLAUDE_SETUP_REPO "$claudeSetupRepo")
fi

exec bwrap "${sandboxArguments[@]}" "$@"
