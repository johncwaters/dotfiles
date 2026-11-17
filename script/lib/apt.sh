# shellcheck shell=bash

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

aptConfDirectory() {
  sandboxRedirectedPath "${DOTFILES_APT_CONF_PATH:-}" /etc/apt/apt.conf.d
}

aptKeyringsDirectory() {
  sandboxRedirectedPath "${DOTFILES_APT_KEYRINGS_PATH:-}" /etc/apt/keyrings
}

# Returns 0 when the target already matches, 2 after writing it, 1 when it could not be written; the staged file is always consumed.
installRootFileIfChanged() {
  local label="$1"
  local stagedPath="$2"
  local targetPath="$3"
  if filesAreIdentical "$stagedPath" "$targetPath"; then
    rm -f -- "$stagedPath"
    return 0
  fi
  if ! canInstallSystemPackages; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "needs root or sudo to write $targetPath"
    return 1
  fi
  if ! runPackageManagerCommand install -D -m 0644 "$stagedPath" "$targetPath" >/dev/null 2>&1; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "could not write $targetPath"
    return 1
  fi
  rm -f -- "$stagedPath"
  return 2
}

# An unpinned third-party repository wins every later upgrade for everything it publishes, not only the package it was added for.
ensureAptRepositoryPin() {
  local label="$1"
  local originName="$2"
  local pinnedPackageName="$3"
  local pinFileName="$4"
  local stagedPath
  local writeStatus=0
  stagedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-apt-pin.XXXXXX")"
  aptRepositoryPinContent "$originName" "$pinnedPackageName" > "$stagedPath"
  installRootFileIfChanged "$label pin" "$stagedPath" "$(aptPreferencesDirectory)/$pinFileName" || writeStatus=$?
  ((writeStatus == 2)) || return 0
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
    ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName" "$pinnedPackageName-ppa"
    return 0
  fi
  if ! addAptRepository "$label" "$repositoryName"; then
    return 0
  fi
  ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName" "$pinnedPackageName-ppa"
}

aptKeyedRepositorySourceContent() {
  local uri="$1"
  local suite="$2"
  local component="$3"
  local keyringPath="$4"
  printf 'Types: deb\nURIs: %s\nSuites: %s\nComponents: %s\nSigned-By: %s\n' \
    "$uri" "$suite" "$component" "$keyringPath"
}

# A repository someone listed by hand keeps its own source and key; only the pin is converged onto it.
ensureAptKeyedRepository() {
  local label="$1"
  local keyringUrl="$2"
  local keyringName="$3"
  local sourcesName="$4"
  local uri="$5"
  local suite="$6"
  local component="$7"
  local originName="$8"
  local pinnedPackageName="$9"
  local manager
  local keyringPath
  local sourcesPath
  local stagedPath
  local writeStatus=0
  local hasWritten=0
  if ! manager="$(detectPackageManager)" || [[ "$manager" != "apt-get" ]]; then
    return 0
  fi
  keyringPath="$(aptKeyringsDirectory)/$keyringName"
  sourcesPath="$(aptSourcesDirectory)/$sourcesName"
  if [[ ! -f "$sourcesPath" ]] && aptRepositoryIsListed "${uri#*://}"; then
    notePresent "$label" "already listed"
    ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName" "${sourcesName%.sources}"
    return 0
  fi
  # Fetched every run: GitHub rotates this key, and a stale keyring fails apt-get update for every topic.
  stagedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-apt-keyring.XXXXXX")"
  if ! curl -fsSL "$keyringUrl" -o "$stagedPath" >/dev/null 2>&1; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "could not download $keyringUrl"
    return 0
  fi
  installRootFileIfChanged "$label key" "$stagedPath" "$keyringPath" || writeStatus=$?
  ((writeStatus != 1)) || return 0
  ((writeStatus != 2)) || hasWritten=1
  writeStatus=0
  stagedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-apt-source.XXXXXX")"
  aptKeyedRepositorySourceContent "$uri" "$suite" "$component" "/etc/apt/keyrings/$keyringName" > "$stagedPath"
  installRootFileIfChanged "$label" "$stagedPath" "$sourcesPath" || writeStatus=$?
  ((writeStatus != 1)) || return 0
  ((writeStatus != 2)) || hasWritten=1
  ensureAptRepositoryPin "$label" "$originName" "$pinnedPackageName" "${sourcesName%.sources}"
  if ((hasWritten == 0)); then
    notePresent "$label" "already listed"
    return 0
  fi
  # The new suite is invisible until the index is read again, and an earlier topic may already have refreshed it.
  forgetPackageIndexRefresh
  noteApplied "$label" "added"
}
