#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

topicDirectory="$dotfilesRepo/vscodium"
codiumUserDirectory="$HOME/.config/VSCodium/User"
if isDarwin; then
  codiumUserDirectory="$HOME/Library/Application Support/VSCodium/User"
fi
codiumExtensionsDirectory="$HOME/.vscode-oss/extensions"
vscodiumManualUrl="https://vscodium.com/#install"
wantedExtensions=()
retiredExtensions=()
installedExtensions=()
missingExtensions=()
retiredPresentExtensions=()
extraExtensions=()
extensionSyncMode=""

vscodiumDebArchitecture() {
  local architecture
  if ! command -v dpkg >/dev/null 2>&1; then
    return 1
  fi
  architecture="$(dpkg --print-architecture 2>/dev/null || true)"
  case "$architecture" in
    amd64 | arm64)
      printf '%s\n' "$architecture"
      return 0
      ;;
  esac
  return 1
}

latestVscodiumDebUrl() {
  local architecture="$1"
  local releaseJsonPath="$2"
  grep -E '"browser_download_url": "https://[^"]+\.deb"' "$releaseJsonPath" \
    | grep -E "($architecture)\\.deb\"" \
    | sed -E 's/.*"browser_download_url": "([^"]+)".*/\1/' \
    | head -n 1
}

# VSCodium ships no apt repository the distro knows, so a machine on apt takes the release .deb.
installVscodiumAptDeb() {
  local label="$1"
  local architecture
  local downloadDirectory
  local releaseJson
  local assetUrl
  local debFile
  local apiConfigPath=""
  if ! canInstallSystemPackages; then
    noteWarned "$label" "apt-get needs root or sudo, install from $vscodiumManualUrl"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    noteWarned "$label" "curl not on PATH, install from $vscodiumManualUrl"
    return 0
  fi
  if ! architecture="$(vscodiumDebArchitecture)"; then
    noteWarned "$label" "unsupported architecture for .deb install, install from $vscodiumManualUrl"
    return 0
  fi
  noteStarting "$label" "installing .deb from GitHub releases"
  downloadDirectory="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-vscodium.XXXXXX")"
  releaseJson="$downloadDirectory/release.json"
  # An argv holding the token is world readable through /proc for as long as curl runs.
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    apiConfigPath="$downloadDirectory/curl.config"
    (umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" > "$apiConfigPath")
  fi
  if ! curl -fsSL ${apiConfigPath:+--config "$apiConfigPath"} \
    https://api.github.com/repos/VSCodium/vscodium/releases/latest -o "$releaseJson"; then
    rm -f -- "$apiConfigPath"
    noteWarned "$label" "release lookup failed, install from $vscodiumManualUrl"
    rm -rf -- "$downloadDirectory"
    return 0
  fi
  rm -f -- "$apiConfigPath"
  assetUrl="$(latestVscodiumDebUrl "$architecture" "$releaseJson" || true)"
  if [[ -z "$assetUrl" ]]; then
    noteWarned "$label" "no matching .deb asset, install from $vscodiumManualUrl"
    rm -rf -- "$downloadDirectory"
    return 0
  fi
  debFile="$(basename -- "$assetUrl")"
  if ! curl -fL "$assetUrl" -o "$downloadDirectory/$debFile"; then
    noteWarned "$label" "download failed, install from $vscodiumManualUrl"
    rm -rf -- "$downloadDirectory"
    return 0
  fi
  if ! installSystemPackagesLogged apt-get "$downloadDirectory/$debFile"; then
    noteWarned "$label" "apt-get install failed: $lastPackageInstallFailure, install from $vscodiumManualUrl"
    rm -rf -- "$downloadDirectory"
    return 0
  fi
  rm -rf -- "$downloadDirectory"
  refreshSessionPath
  if command -v codium >/dev/null 2>&1; then
    noteInstalled "$label" "installed"
    return 0
  fi
  noteWarned "$label" "installed, but open a new shell for PATH"
}

installVscodium() {
  refreshSessionPath
  if command -v codium >/dev/null 2>&1; then
    notePresent "VSCodium" "already installed"
    return 0
  fi
  if [[ "$(detectPackageManager || true)" == "apt-get" ]]; then
    installVscodiumAptDeb "VSCodium"
    return 0
  fi
  installPackageTool "VSCodium" "codium" "vscodium" "$vscodiumManualUrl"
}

useBundledCodiumOnDarwin() {
  if command -v codium >/dev/null 2>&1; then
    return 0
  fi
  if ! isDarwin; then
    return 0
  fi
  local bundledCodiumDirectory
  bundledCodiumDirectory="$(codiumBundleBinDirectory)"
  if [[ ! -x "$bundledCodiumDirectory/codium" ]]; then
    return 0
  fi
  PATH="$bundledCodiumDirectory:$PATH"
  export PATH
  hash -r 2>/dev/null || true
}

# An absent profile file means exact, the long-standing default; an unreadable one is different, because pruning on a guess uninstalls what the owner wanted.
resolveExtensionSyncMode() {
  local modePath
  local readStatus=0
  if [[ -z "${profileName:-}" ]]; then
    extensionSyncMode="additive"
    noteWarned "extensions" "no profile resolved, extras left alone"
    return 0
  fi
  modePath="$dotfilesRepo/profiles/$profileName/vscodium.json"
  extensionSyncMode="$(readProfileSetting "$modePath" "extensionSync")" || readStatus=$?
  if ((readStatus == 0)); then
    if [[ "$extensionSyncMode" == "exact" || "$extensionSyncMode" == "additive" ]]; then
      return 0
    fi
    noteWarned "extensions" "$modePath sets extensionSync to $extensionSyncMode, not exact or additive, extras left alone"
    extensionSyncMode="additive"
    return 0
  fi
  if ((readStatus == 1)); then
    extensionSyncMode="exact"
    return 0
  fi
  extensionSyncMode="additive"
  noteWarned "extensions" "$modePath names no readable extensionSync, extras left alone"
}

listHasExtension() {
  local wantedExtension="$1"
  shift
  local candidateExtension
  for candidateExtension in "$@"; do
    if [[ "$candidateExtension" == "$wantedExtension" ]]; then
      return 0
    fi
  done
  return 1
}

# A listing that failed reads as an empty machine, which reinstalls every extension and prunes none, so its status is captured instead of piped away.
readExtensionLists() {
  local extensionName
  local listingPath
  local listingStatus=0
  mapfile -t wantedExtensions < <(readPackageList "$topicDirectory/extensions.txt")
  mapfile -t retiredExtensions < <(readPackageList "$topicDirectory/extensions-remove.txt")
  listingPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-codium-extensions.XXXXXX")"
  codium --list-extensions > "$listingPath" 2>/dev/null || listingStatus=$?
  if ((listingStatus != 0)); then
    rm -f -- "$listingPath"
    return 1
  fi
  mapfile -t installedExtensions < "$listingPath"
  rm -f -- "$listingPath"
  missingExtensions=()
  retiredPresentExtensions=()
  extraExtensions=()
  for extensionName in ${wantedExtensions[@]+"${wantedExtensions[@]}"}; do
    if listHasExtension "$extensionName" ${installedExtensions[@]+"${installedExtensions[@]}"}; then
      continue
    fi
    missingExtensions+=("$extensionName")
  done
  for extensionName in ${installedExtensions[@]+"${installedExtensions[@]}"}; do
    if listHasExtension "$extensionName" ${wantedExtensions[@]+"${wantedExtensions[@]}"}; then
      continue
    fi
    if listHasExtension "$extensionName" ${retiredExtensions[@]+"${retiredExtensions[@]}"}; then
      retiredPresentExtensions+=("$extensionName")
      continue
    fi
    extraExtensions+=("$extensionName")
  done
}

installMissingExtensions() {
  local extensionName
  for extensionName in ${missingExtensions[@]+"${missingExtensions[@]}"}; do
    noteStarting "$extensionName" "installing"
    if codium --install-extension "$extensionName" >/dev/null; then
      noteInstalled "$extensionName" "installed"
      continue
    fi
    noteWarned "$extensionName" "install failed"
  done
}

removeRetiredExtensions() {
  local extensionName
  if ((${#retiredPresentExtensions[@]} == 0)); then
    notePresent "extension removals" "none present"
    return 0
  fi
  for extensionName in "${retiredPresentExtensions[@]}"; do
    noteStarting "$extensionName" "uninstalling (retired)"
    if codium --uninstall-extension "$extensionName" >/dev/null; then
      noteApplied "$extensionName" "removed"
      continue
    fi
    noteWarned "$extensionName" "uninstall failed"
  done
}

# Zero is unpublished, one is published, anything else is a manifest this run could not read; without node nothing here is read, and grepping for the word private answers neither way.
inspectExtensionManifest() {
  local manifestPath="$1"
  local inspectStatus=0
  if ! command -v node >/dev/null 2>&1; then
    return 2
  fi
  node -e '
    let manifest;
    try {
      manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    } catch {
      process.exit(2);
    }
    if (manifest === null || typeof manifest !== "object") process.exit(2);
    process.exit(manifest.private === true ? 0 : 1);
  ' "$manifestPath" 2>/dev/null || inspectStatus=$?
  return "$inspectStatus"
}

# An unpublished extension comes from a vsix no marketplace serves, so pruning it is not reversible by rerunning this topic; a manifest that will not parse says nothing either way.
extensionPublishState() {
  local extensionName="$1"
  local lowercaseExtensionName
  local manifestPath
  local inspectStatus
  local manifestsRead=0
  lowercaseExtensionName="$(printf '%s\n' "$extensionName" | tr '[:upper:]' '[:lower:]')"
  for manifestPath in "$codiumExtensionsDirectory/$lowercaseExtensionName"-[0-9]*/package.json; do
    if [[ ! -f "$manifestPath" ]]; then
      continue
    fi
    manifestsRead=1
    inspectStatus=0
    inspectExtensionManifest "$manifestPath" || inspectStatus=$?
    if ((inspectStatus == 0)); then
      printf 'unpublished\n'
      return 0
    fi
    if ((inspectStatus != 1)); then
      printf 'unreadable\n'
      return 0
    fi
  done
  if ((manifestsRead == 0)); then
    printf 'unreadable\n'
    return 0
  fi
  printf 'published\n'
}

removeExtraExtensions() {
  local extensionName
  local publishState
  for extensionName in ${extraExtensions[@]+"${extraExtensions[@]}"}; do
    publishState="$(extensionPublishState "$extensionName")"
    if [[ "$publishState" == "unpublished" ]]; then
      noteDetail "$extensionName" "kept, unpublished extension"
      continue
    fi
    if [[ "$publishState" == "unreadable" ]]; then
      noteWarned "$extensionName" "kept, its package.json could not be read"
      continue
    fi
    noteStarting "$extensionName" "uninstalling (not in extensions.txt)"
    if codium --uninstall-extension "$extensionName" >/dev/null; then
      noteApplied "$extensionName" "removed"
      continue
    fi
    noteWarned "$extensionName" "uninstall failed"
  done
}

syncExtensions() {
  if ! command -v codium >/dev/null 2>&1; then
    noteWarned "codium" "not on PATH, skipping extensions"
    return 0
  fi
  if [[ ! -f "$topicDirectory/extensions.txt" ]]; then
    noteWarned "extensions" "no vscodium/extensions.txt, nothing synced"
    return 0
  fi
  resolveExtensionSyncMode
  if ! readExtensionLists; then
    noteWarned "extensions" "codium --list-extensions failed, nothing synced"
    return 0
  fi
  removeRetiredExtensions
  if [[ "$extensionSyncMode" == "exact" ]] && ((${#missingExtensions[@]} == 0)) && ((${#extraExtensions[@]} == 0)); then
    notePresent "extensions" "all ${#wantedExtensions[@]} in sync"
  fi
  if [[ "$extensionSyncMode" != "exact" ]] && ((${#missingExtensions[@]} == 0)); then
    notePresent "extensions" "all ${#wantedExtensions[@]} present"
  fi
  installMissingExtensions
  if [[ "$extensionSyncMode" == "exact" ]]; then
    removeExtraExtensions
    return 0
  fi
  if ((${#extraExtensions[@]} > 0)); then
    notePresent "extensions extra" "${#extraExtensions[@]} kept (additive sync)"
  fi
}

useBundledCodiumOnDarwin
installVscodium
useBundledCodiumOnDarwin

linkEntry "VSCodium settings" "vscodium/settings.json" "$codiumUserDirectory/settings.json"
keybindingsFile="vscodium/keybindings.json"
if isDarwin; then
  keybindingsFile="vscodium/keybindings.darwin.json"
fi
linkEntry "VSCodium keybindings" "$keybindingsFile" "$codiumUserDirectory/keybindings.json"
convergeProfileLink "VSCodium mcp.json" "vscodium-mcp.json" "$codiumUserDirectory/mcp.json"

writeSection "Extensions"
syncExtensions

finishTopic
