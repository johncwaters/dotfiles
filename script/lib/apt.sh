# shellcheck shell=bash
# Requires packages.sh, which sources this file.

# Root owned paths these name, so a test run inside a marked sandbox home points them elsewhere; outside one the redirect is ignored.
aptSourcesDirectory() {
  sandboxRedirectedPath "${DOTFILES_APT_SOURCES_PATH:-}" /etc/apt/sources.list.d
}

aptPreferencesDirectory() {
  sandboxRedirectedPath "${DOTFILES_APT_PREFERENCES_PATH:-}" /etc/apt/preferences.d
}

# apt reads only *.list and *.sources, and a marker behind a comment is a repository apt does not have.
aptRepositoryIsListed() {
  local repositoryMarker="$1"
  local sourcesDirectory
  local sourceFile
  sourcesDirectory="$(aptSourcesDirectory)"
  for sourceFile in "$sourcesDirectory"/*.list "$sourcesDirectory"/*.sources \
    "$(dirname -- "$sourcesDirectory")/sources.list"; do
    if [[ -f "$sourceFile" ]] && grep -v '^[[:space:]]*#' "$sourceFile" | grep -qF -- "$repositoryMarker"; then
      return 0
    fi
  done
  return 1
}

aptRepositoryPinContent() {
  local originName="$1"
  local pinnedPackageName="$2"
  printf 'Package: *\nPin: release o=%s\nPin-Priority: 1\n\nPackage: %s\nPin: release o=%s\nPin-Priority: 500\n' \
    "$originName" "$pinnedPackageName" "$originName"
}

# An unpinned PPA wins every later upgrade for everything it publishes, not only the package it was added for.
ensureAptRepositoryPin() {
  local label="$1"
  local originName="$2"
  local pinnedPackageName="$3"
  local pinPath
  local stagedPath
  pinPath="$(aptPreferencesDirectory)/$pinnedPackageName-ppa"
  stagedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-apt-pin.XXXXXX")"
  aptRepositoryPinContent "$originName" "$pinnedPackageName" > "$stagedPath"
  if filesAreIdentical "$stagedPath" "$pinPath"; then
    rm -f -- "$stagedPath"
    return 0
  fi
  if ! canInstallSystemPackages; then
    rm -f -- "$stagedPath"
    noteWarned "$label pin" "needs root or sudo, pin $originName manually"
    return 0
  fi
  if ! runPackageManagerCommand install -m 0644 "$stagedPath" "$pinPath" >/dev/null 2>&1; then
    rm -f -- "$stagedPath"
    noteWarned "$label pin" "could not write $pinPath"
    return 0
  fi
  rm -f -- "$stagedPath"
  noteApplied "$label pin" "only $pinnedPackageName comes from $originName"
}

addAptRepository() {
  local label="$1"
  local repositoryName="$2"
  local addRepositoryLog
  local addRepositoryStatus=0
  if ! canInstallSystemPackages; then
    noteWarned "$label" "apt-get needs root or sudo, add $repositoryName manually"
    return 1
  fi
  noteStarting "$label" "adding $repositoryName"
  addRepositoryLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-apt-repository.XXXXXX")"
  runPackageManagerCommand add-apt-repository -y "$repositoryName" \
    >>"$addRepositoryLog" 2>&1 || addRepositoryStatus=$?
  if ((addRepositoryStatus == 127)); then
    rm -f -- "$addRepositoryLog"
    noteWarned "$label" "add-apt-repository not installed, add $repositoryName manually"
    return 1
  fi
  if ((addRepositoryStatus != 0)); then
    noteWarned "$label" "add failed: $(lastLogLine "$addRepositoryLog")"
    rm -f -- "$addRepositoryLog"
    return 1
  fi
  rm -f -- "$addRepositoryLog"
  # The new suite is invisible until the index is read again, and an earlier topic may already have refreshed it.
  forgetPackageIndexRefresh
  noteApplied "$label" "added"
}

ensureAptRepository() {
  local label="$1"
  local repositoryName="$2"
  local pinnedPackageName="$3"
  local repositoryMarker="${repositoryName#ppa:}"
  local manager
  local originName
  if ! manager="$(detectPackageManager)"; then
    return 0
  fi
  if [[ "$manager" != "apt-get" ]]; then
    return 0
  fi
  originName="LP-PPA-${repositoryMarker//\//-}"
  if aptRepositoryIsListed "$repositoryMarker"; then
    notePresent "$label" "already listed"
    ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName"
    return 0
  fi
  if ! addAptRepository "$label" "$repositoryName"; then
    return 0
  fi
  ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName"
}
