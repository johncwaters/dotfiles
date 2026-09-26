#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
source "$dotfilesRepo/script/lib/packages.sh"

gnupgHomeDirectory="$HOME/.gnupg"
gpgAgentConfigPath="$gnupgHomeDirectory/gpg-agent.conf"
passwordStoreDirectory="${PASSWORD_STORE_DIR:-$HOME/.password-store}"

pinentryCommandName() {
  if isDarwin; then
    printf 'pinentry-mac\n'
    return 0
  fi
  printf 'pinentry-curses\n'
}

installSecretsTools() {
  installPackageTool "pass" "pass" "pass"
  installPackageTool "GnuPG" "gpg" "gnupg"
  installPackageTool "pinentry" "$(pinentryCommandName)" "$(pinentryCommandName)"
}

# A same-account writable PATH entry such as ~/.local/bin would otherwise run a planted pinentry, pass or gh that captures the passphrase or token.
reportRefusedPathOnlyCommand() {
  local label="$1"
  local commandName="$2"
  local consequence="$3"
  local pathOnlyCandidate
  pathOnlyCandidate="$(command -v "$commandName" 2>/dev/null || true)"
  if [[ -z "$pathOnlyCandidate" ]]; then
    return 1
  fi
  noteWarned "$label" "refusing $pathOnlyCandidate outside the system and Homebrew prefixes, $consequence"
}

reportUnusablePinentry() {
  local label="$1"
  local pinentryName="$2"
  if reportRefusedPathOnlyCommand "$label" "$pinentryName" "config not rendered"; then
    return 0
  fi
  noteWarned "$label" "no $pinentryName in the system or Homebrew prefixes, config not rendered"
}

renderGpgAgentConfig() {
  local label="gpg-agent config"
  local pinentryName
  local pinentryProgramPath
  local agentConfigTemplate
  local stagedPath
  pinentryName="$(pinentryCommandName)"
  pinentryProgramPath="$(resolveSystemCommand "$pinentryName" || true)"
  if [[ -z "$pinentryProgramPath" ]]; then
    reportUnusablePinentry "$label" "$pinentryName"
    return 1
  fi
  if ! mkdir -p -- "$gnupgHomeDirectory" || ! chmod 700 "$gnupgHomeDirectory"; then
    noteWarned "$label" "cannot make ~/.gnupg owner only"
    return 1
  fi
  if ! clearDestinationIfNotPlainFile "$label" "$gpgAgentConfigPath"; then
    return 1
  fi
  agentConfigTemplate="$(< "$dotfilesRepo/secrets/gpg-agent.conf")"
  stagedPath="$(mktemp "$gnupgHomeDirectory/.dotfiles-gpg-agent.XXXXXX")"
  chmod 600 "$stagedPath"
  printf '%s\n' "${agentConfigTemplate//\{\{PINENTRY_PROGRAM\}\}/$pinentryProgramPath}" > "$stagedPath"
  commitStagedFile "$label" "$stagedPath" "$gpgAgentConfigPath" "pinentry-program $pinentryProgramPath"
  ((stagedFileChangedDestination == 1))
}

reloadGpgAgent() {
  local gpgconfPath
  gpgconfPath="$(resolveSystemCommand gpgconf || true)"
  if [[ -z "$gpgconfPath" ]]; then
    reportRefusedPathOnlyCommand "gpg-agent" "gpgconf" "restart gpg-agent by hand" \
      || noteWarned "gpg-agent" "no gpgconf in the system or Homebrew prefixes, restart gpg-agent by hand"
    return 0
  fi
  if ! "$gpgconfPath" --kill gpg-agent >/dev/null 2>&1; then
    noteWarned "gpg-agent" "gpgconf --kill gpg-agent failed, restart it by hand"
    return 0
  fi
  noteApplied "gpg-agent" "reloaded to read the new config"
}

reportPasswordStore() {
  local label="password store"
  if [[ -f "$passwordStoreDirectory/.gpg-id" ]]; then
    notePresent "$label" "initialized"
    return 0
  fi
  noteWarned "$label" \
    "not initialized, run gpg --quick-generate-key '<email>' default default never, then pass init '<email>'"
}

githubTokenPassEntry="github/token"

passwordStoreEntryExists() {
  [[ -f "$passwordStoreDirectory/$1.gpg" ]]
}

showPassEntryWithoutPrompting() {
  local passPath="$1"
  local entryName="$2"
  PATH="$(systemCommandSearchPath)" \
    PASSWORD_STORE_GPG_OPTS="${PASSWORD_STORE_GPG_OPTS:+$PASSWORD_STORE_GPG_OPTS }--pinentry-mode error" \
    "$passPath" show "$entryName" 2>/dev/null </dev/null
}

printFirstLineOfStandardInput() {
  local firstLine
  if ! IFS= read -r firstLine && [[ -z "$firstLine" ]]; then
    return 1
  fi
  printf '%s\n' "$firstLine"
}

printFirstLineOfPassEntryWithoutPrompting() {
  showPassEntryWithoutPrompting "$1" "$2" | printFirstLineOfStandardInput
}

githubHostsFilePath="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}/hosts.yml"
githubConfigDirectoryPath="${githubHostsFilePath%/*}"

physicalGithubConfigDirectoryPath() {
  local existingAncestorPath="$githubConfigDirectoryPath"
  local physicalAncestorPath
  while [[ ! -e "$existingAncestorPath" && ! -L "$existingAncestorPath" && "$existingAncestorPath" == */* ]]; do
    existingAncestorPath="${existingAncestorPath%/*}"
  done
  physicalAncestorPath="$(cd -P -- "${existingAncestorPath:-/}" 2>/dev/null && pwd)" || return 1
  printf '%s%s\n' "$physicalAncestorPath" "${githubConfigDirectoryPath#"$existingAncestorPath"}"
}

unlinkedGithubConfigDirectoryPath() {
  local physicalHomePath
  if [[ "$githubConfigDirectoryPath" != "$HOME"/* ]] || ! physicalHomePath="$(cd -P -- "$HOME" 2>/dev/null && pwd)"; then
    printf '%s\n' "$githubConfigDirectoryPath"
    return 0
  fi
  printf '%s%s\n' "$physicalHomePath" "${githubConfigDirectoryPath#"$HOME"}"
}

ghSupportsPlainTextLogin() {
  local ghPath="$1"
  local authStatusHelp
  local authLoginHelp
  authStatusHelp="$("$ghPath" auth status --help 2>&1 || true)"
  authLoginHelp="$("$ghPath" auth login --help 2>&1 || true)"
  [[ "$authStatusHelp" == *"--active"* && "$authLoginHelp" == *"--insecure-storage"* ]]
}

# Sandboxed sessions can mask a token only in hosts.yml; a keyring token is unreachable there, so gh fails inside them.
githubTokenIsInHostsFile() {
  local authStatusReport
  authStatusReport="$("$1" auth status --active --hostname github.com 2>&1)" && [[ "$authStatusReport" != *"(keyring)"* ]]
}

restrictGithubHostsFile() {
  local label="$1"
  if [[ -L "$githubHostsFilePath" || ! -f "$githubHostsFilePath" ]]; then
    noteWarned "$label" "no plain hosts.yml at $githubHostsFilePath after the login"
    return 1
  fi
  if ! chmod 600 "$githubHostsFilePath"; then
    noteWarned "$label" "cannot make $githubHostsFilePath owner only"
    return 1
  fi
}

logInToGithubFromPassEntry() {
  local label="$1"
  local ghPath="$2"
  local currentAuthState="$3"
  local passPath
  local githubConfigDirectoryResolvedPath
  passPath="$(resolveSystemCommand pass || true)"
  if [[ -z "$passPath" ]]; then
    reportRefusedPathOnlyCommand "$label" "pass" "not logging in from $githubTokenPassEntry" \
      || noteDetail "$label" "$currentAuthState, no pass in the system or Homebrew prefixes to log in from $githubTokenPassEntry"
    return 0
  fi
  if ! passwordStoreEntryExists "$githubTokenPassEntry"; then
    noteDetail "$label" "$currentAuthState, pass insert $githubTokenPassEntry and rerun to log in from the store"
    return 0
  fi
  if ! githubConfigDirectoryResolvedPath="$(physicalGithubConfigDirectoryPath)" \
    || [[ "$githubConfigDirectoryResolvedPath" != "$(unlinkedGithubConfigDirectoryPath)" ]]; then
    noteWarned "$label" "resolves through a symlink to ${githubConfigDirectoryResolvedPath:-an unresolvable path}, not writing a token through it: $githubConfigDirectoryPath"
    return 0
  fi
  if ! pathIsPlainFileOrAbsent "$githubHostsFilePath"; then
    noteWarned "$label" "not a regular file, not writing a token through it: $githubHostsFilePath"
    return 0
  fi
  if [[ -f "$githubHostsFilePath" ]] && ! chmod 600 "$githubHostsFilePath"; then
    noteWarned "$label" "cannot make $githubHostsFilePath owner only before the login"
    return 0
  fi
  noteStarting "$label" "logging in with the $githubTokenPassEntry pass entry"
  if ! printFirstLineOfPassEntryWithoutPrompting "$passPath" "$githubTokenPassEntry" \
    | "$ghPath" auth login --with-token --insecure-storage >/dev/null 2>&1 || ! githubTokenIsInHostsFile "$ghPath"; then
    noteWarned "$label" "login from $githubTokenPassEntry failed; if pass is locked, run pass show $githubTokenPassEntry >/dev/null and rerun"
    return 0
  fi
  if ! restrictGithubHostsFile "$label"; then
    return 0
  fi
  noteApplied "$label" "logged in from the $githubTokenPassEntry pass entry, token in $githubHostsFilePath"
}

loginToGithubFromPasswordStore() {
  local label="GitHub auth"
  local ghPath
  local authStatusReport
  ghPath="$(resolveSystemCommand gh || true)"
  if [[ -z "$ghPath" ]]; then
    reportRefusedPathOnlyCommand "$label" "gh" "not logging in" || true
    return 0
  fi
  if ! ghSupportsPlainTextLogin "$ghPath"; then
    noteDetail "$label" "gh at $ghPath lacks auth status --active or auth login --insecure-storage, gh 2.40 or newer needed to log in from $githubTokenPassEntry"
    return 0
  fi
  if ! authStatusReport="$("$ghPath" auth status --active --hostname github.com 2>&1)"; then
    logInToGithubFromPassEntry "$label" "$ghPath" "not logged in"
    return 0
  fi
  if [[ "$authStatusReport" != *"(keyring)"* ]]; then
    notePresent "$label" "logged in"
    return 0
  fi
  logInToGithubFromPassEntry "$label" "$ghPath" "token in the system keyring, which sandboxed sessions cannot read"
}

# Root owned paths, so a test run inside a marked sandbox home points them elsewhere; outside one the redirect is ignored.
ptraceScopeDropInPath="$(sandboxRedirectedPath "${DOTFILES_PTRACE_SYSCTL_PATH:-}" /etc/sysctl.d/10-ptrace.conf)"
ptraceScopeLivePath="$(sandboxRedirectedPath "${DOTFILES_PTRACE_SCOPE_PATH:-}" /proc/sys/kernel/yama/ptrace_scope)"
ptraceScopeSetting="kernel.yama.ptrace_scope = 1"

livePtraceScope() {
  local liveScope
  if [[ ! -r "$ptraceScopeLivePath" ]] || ! read -r liveScope < "$ptraceScopeLivePath"; then
    return 1
  fi
  if [[ ! "$liveScope" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$liveScope"
}

# A distro drop-in of the same name (Ubuntu ships one) already restricts ptrace, so any setting of 1 to 3 counts as current.
ptraceDropInIsCurrent() {
  [[ -f "$ptraceScopeDropInPath" && ! -L "$ptraceScopeDropInPath" ]] \
    && grep -Eq '^[[:space:]]*kernel\.yama\.ptrace_scope[[:space:]]*=[[:space:]]*[123][[:space:]]*$' "$ptraceScopeDropInPath"
}

reportUnpersistedPtraceScope() {
  local label="ptrace scope"
  local liveScope="$1"
  if ((liveScope >= 1)); then
    notePresent "$label" \
      "live scope $liveScope, not persisted; to persist run: echo '$ptraceScopeSetting' | sudo tee $ptraceScopeDropInPath"
    return 0
  fi
  noteWarned "$label" \
    "needs root, run: echo '$ptraceScopeSetting' | sudo tee $ptraceScopeDropInPath && sudo sysctl --system"
}

writePtraceDropIn() {
  local label="ptrace scope"
  local liveScope="$1"
  local stagedPath
  local backupPath
  if ! pathIsPlainFileOrAbsent "$ptraceScopeDropInPath"; then
    noteWarned "$label" "not a regular file, leaving it alone: $ptraceScopeDropInPath"
    return 1
  fi
  # canInstallSystemPackages warns on a password-wanting sudo, which would fail a converge whose live scope is already restrictive.
  if ! canRunRootCommandsWithoutPrompt; then
    reportUnpersistedPtraceScope "$liveScope"
    return 1
  fi
  if [[ -f "$ptraceScopeDropInPath" ]]; then
    backupPath="$(nextBackupPath "$ptraceScopeDropInPath")"
    if ! runPackageManagerCommand cp -p -- "$ptraceScopeDropInPath" "$backupPath" >/dev/null 2>&1; then
      noteWarned "$label" "cannot back up $ptraceScopeDropInPath"
      return 1
    fi
    noteApplied "$label backup" "saved $(basename -- "$backupPath")"
  fi
  stagedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-ptrace-scope.XXXXXX")"
  printf '%s\n' "$ptraceScopeSetting" > "$stagedPath"
  if ! runPackageManagerCommand install -m 0644 "$stagedPath" "$ptraceScopeDropInPath" >/dev/null 2>&1; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "cannot write $ptraceScopeDropInPath"
    return 1
  fi
  rm -f -- "$stagedPath"
  noteApplied "$label" "persisted $ptraceScopeSetting in $ptraceScopeDropInPath"
}

applyPtraceDropIn() {
  local label="ptrace scope"
  local liveScope
  if canInstallSystemPackages; then
    runPackageManagerCommand sysctl --system >/dev/null 2>&1 || true
  fi
  liveScope="$(livePtraceScope || printf '0\n')"
  if ((liveScope >= 1)); then
    noteApplied "$label" "live scope now $liveScope"
    return 0
  fi
  noteWarned "$label" "live scope still 0, run: sudo sysctl --system"
}

# Any process of this account can otherwise read another's memory, including a decrypted secret held by gpg-agent or a shell.
ensurePtraceScope() {
  local label="ptrace scope"
  local liveScope
  if isDarwin; then
    return 0
  fi
  if ! liveScope="$(livePtraceScope)"; then
    noteWarned "$label" "cannot read $ptraceScopeLivePath, is Yama enabled?"
    return 0
  fi
  if ! ptraceDropInIsCurrent && ! writePtraceDropIn "$liveScope"; then
    return 0
  fi
  if ((liveScope >= 1)); then
    notePresent "$label" "live scope $liveScope, persisted"
    return 0
  fi
  applyPtraceDropIn
}

ensurePtraceScope
installSecretsTools
if renderGpgAgentConfig; then
  reloadGpgAgent
fi
reportPasswordStore
loginToGithubFromPasswordStore

finishTopic
