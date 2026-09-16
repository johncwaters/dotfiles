#!/usr/bin/env bash
# The vendor installer needs root, so it runs through the one gated sudo rather than a pipe into a shell.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

reportTailscaleAuthStatus() {
  local authHint="run sudo tailscale up once"
  local tailscaleCommand="tailscale"
  if isDarwin; then
    authHint="open the Tailscale app and sign in"
    tailscaleCommand="$(tailscaleBundleCliPath)"
  fi
  if "$tailscaleCommand" status >/dev/null 2>&1; then
    notePresent "Tailscale auth" "authenticated"
    return 0
  fi
  noteWarned "Tailscale auth" "$authHint"
}

installTailscale() {
  if isDarwin; then
    installPackageTool "Tailscale" "tailscale" "tailscale" "https://tailscale.com/download/mac"
    if toolIsPresent "tailscale" "tailscale"; then
      reportTailscaleAuthStatus
    fi
    return 0
  fi
  refreshSessionPath
  if command -v tailscale >/dev/null 2>&1; then
    notePresent "Tailscale" "already installed"
    reportTailscaleAuthStatus
    return 0
  fi
  noteStarting "Tailscale" "running official installer"
  local installerLog
  installerLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-tailscale-install.XXXXXX")"
  waitForPackageManagerLock
  if ! installFromVendorScript "Tailscale" sh https://tailscale.com/install.sh "$installerLog" 1; then
    rm -f -- "$installerLog"
    return 0
  fi
  rm -f -- "$installerLog"
  refreshSessionPath
  if ! command -v tailscale >/dev/null 2>&1; then
    noteWarned "Tailscale" "installed, but not on PATH yet"
    return 0
  fi
  noteInstalled "Tailscale" "installed"
  reportTailscaleAuthStatus
}

installTailscale

finishTopic
