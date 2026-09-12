# shellcheck shell=bash
# Requires context.sh and loads it when a topic has not already done so.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=./context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/context.sh"
fi

: "${detectedPackageManager:=}"
: "${aptUpdated:=0}"
: "${packageInstallLog:=}"
: "${dpkgLockWaitSeconds:=180}"
: "${minimumNodeMajor:=22}"
: "${minimumNodeMinor:=18}"
: "${userNpmPrefixEnsured:=0}"
: "${passwordlessSudoProbe:=unknown}"
: "${lastPackageInstallFailure:=}"

userNpmPrefixDirectory() {
  printf '%s\n' "$HOME/.npm-global"
}

isRoot() {
  [[ "$EUID" -eq 0 ]]
}

# runPackageManagerCommand runs sudo -n, so probing for the binary alone turns a password-wanting sudo into "install failed" naming no cause.
passwordlessSudoWorks() {
  if [[ "$passwordlessSudoProbe" == "unknown" ]]; then
    passwordlessSudoProbe=refused
    if sudo -n true >/dev/null 2>&1; then
      passwordlessSudoProbe=granted
    fi
  fi
  [[ "$passwordlessSudoProbe" == "granted" ]]
}

canInstallSystemPackages() {
  if isRoot; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  if passwordlessSudoWorks; then
    return 0
  fi
  if [[ "$passwordlessSudoProbe" != "reported" ]]; then
    passwordlessSudoProbe=reported
    noteWarned "sudo" "sudo needs a password, run sudo -v first"
  fi
  return 1
}

# getent is named absolutely: a PATH this account controls must not decide whether the account's own home is recognised.
accountPasswdHome() {
  local passwdFields=()
  if [[ ! -x /usr/bin/getent ]]; then
    return 1
  fi
  IFS=: read -r -a passwdFields < <(/usr/bin/getent passwd "$EUID" 2>/dev/null)
  printf '%s\n' "${passwdFields[5]:-}"
}

forgetPackageIndexRefresh() {
  aptUpdated=0
}

# The harness always runs out of a directory it made, so a marker in the account's own home is somebody planting one.
homeIsTheAccountsOwnHome() {
  local passwdHome
  passwdHome="$(accountPasswdHome)"
  [[ -n "$passwdHome" && "$passwdHome" == "$HOME" ]]
}

# An environment variable alone must never redirect what runs as root, so the seam opens only inside a home the test harness marked and this account owns.
sandboxStubBinDirectory() {
  local stubBinDirectory="${DOTFILES_TEST_STUB_BIN:-}"
  local sandboxMarker="$HOME/.dotfiles-test-sandbox"
  if [[ -z "$stubBinDirectory" ]]; then
    return 1
  fi
  if homeIsTheAccountsOwnHome; then
    return 1
  fi
  if [[ -L "$sandboxMarker" || ! -f "$sandboxMarker" || ! -O "$sandboxMarker" ]]; then
    return 1
  fi
  if [[ ! -O "$HOME" ]]; then
    return 1
  fi
  printf '%s\n' "$stubBinDirectory"
}

# A caller-supplied path that redirects a root write opens the same seam the stubs do, so it is honoured only inside the home the harness marked.
sandboxRedirectedPath() {
  local redirectedPath="$1"
  local productionPath="$2"
  if [[ -n "$redirectedPath" ]] && sandboxStubBinDirectory >/dev/null; then
    printf '%s\n' "$redirectedPath"
    return 0
  fi
  printf '%s\n' "$productionPath"
}

# sudo resolves a bare name against a PATH this account controls, so what runs as root is named by absolute path.
systemCommandSearchPath() {
  local stubBinDirectory
  stubBinDirectory="$(sandboxStubBinDirectory || true)"
  printf '%s\n' "${stubBinDirectory:+$stubBinDirectory:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

resolveSystemCommand() {
  (
    PATH="$(systemCommandSearchPath)"
    hash -r 2>/dev/null || true
    type -P "$1" 2>/dev/null
  )
}

# sudo -n, so an unattended converge fails into a caller's warning instead of a prompt.
runPackageManagerCommand() {
  local commandPath
  commandPath="$(resolveSystemCommand "$1")"
  if [[ -z "$commandPath" ]]; then
    return 127
  fi
  shift
  if isRoot; then
    "$commandPath" "$@"
    return $?
  fi
  sudo -n "$commandPath" "$@"
}

# An unattended converge must not sit on a credential prompt no carbon unit will answer, and ssh has prompts of its own that GIT_TERMINAL_PROMPT does not reach.
runBatchNetworkCommand() {
  local batchSshCommand="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="$batchSshCommand" \
    "$@" < /dev/null
}

runGitNetworkCommand() {
  runBatchNetworkCommand git "$@"
}

detectPackageManager() {
  if [[ -n "$detectedPackageManager" ]]; then
    printf '%s\n' "$detectedPackageManager"
    return 0
  fi
  local candidateManager
  for candidateManager in apt-get dnf pacman zypper; do
    if command -v "$candidateManager" >/dev/null 2>&1; then
      detectedPackageManager="$candidateManager"
      printf '%s\n' "$detectedPackageManager"
      return 0
    fi
  done
  return 1
}

# packagekitd and unattended-upgrades hold the dpkg lock for minutes; apt fails rather than wait.
installSystemPackages() {
  local manager="$1"
  shift
  local outputSink="${packageInstallLog:-/dev/null}"
  case "$manager" in
    apt-get)
      if ((aptUpdated == 0)); then
        if ! runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" update >>"$outputSink" 2>&1; then
          return 1
        fi
        aptUpdated=1
      fi
      runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" install -y "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    dnf)
      runPackageManagerCommand dnf install -y "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    pacman)
      runPackageManagerCommand pacman -S --noconfirm --needed "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    zypper)
      runPackageManagerCommand zypper --non-interactive install "$@" >>"$outputSink" 2>&1
      return $?
      ;;
  esac
  return 1
}

withPackageInstallLog() {
  local packageInstallLog="$1"
  shift
  local commandStatus=0
  "$@" || commandStatus=$?
  return "$commandStatus"
}

installSystemPackagesLogged() {
  local manager="$1"
  shift
  local scopedInstallLog
  local installStatus=0
  scopedInstallLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-install-log.XXXXXX")"
  withPackageInstallLog "$scopedInstallLog" installSystemPackages "$manager" "$@" \
    || installStatus=$?
  if ((installStatus != 0)); then
    lastPackageInstallFailure="$(lastLogLine "$scopedInstallLog")"
  fi
  rm -f -- "$scopedInstallLog"
  return "$installStatus"
}

removeAptPackageWithoutDependents() {
  local packageName="$1"
  local logPath="$2"
  local additionalRemovalPackages=()
  local removalPlan
  if ! removalPlan="$(runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" -s remove "$packageName" 2>&1)"; then
    printf '%s\n' "$removalPlan" >> "$logPath"
    return 1
  fi
  printf '%s\n' "$removalPlan" >> "$logPath"
  mapfile -t additionalRemovalPackages < <(
    awk -v wantedPackage="$packageName" \
      '$1 == "Remv" { split($2, packageParts, ":"); if (packageParts[1] != wantedPackage) print $2 }' \
      <<< "$removalPlan"
  )
  if ((${#additionalRemovalPackages[@]} > 0)); then
    printf 'refusing to remove %s because apt would also remove: %s\n' \
      "$packageName" "${additionalRemovalPackages[*]}" >> "$logPath"
    return 1
  fi
  runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" \
    remove -y "$packageName" >> "$logPath" 2>&1
}

# The lock timeout cannot reach a third-party installer's own apt-get, so block for it first.
waitForPackageManagerLock() {
  local manager
  if ! manager="$(detectPackageManager)"; then
    return 0
  fi
  if [[ "$manager" != "apt-get" ]]; then
    return 0
  fi
  if ! canInstallSystemPackages; then
    return 0
  fi
  runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" check >/dev/null 2>&1 || true
}

lastLogLine() {
  local logPath="$1"
  grep -v '^[[:space:]]*$' "$logPath" 2>/dev/null | tail -n 1 | cut -c1-100
}

refreshSessionPath() {
  local userLocalBin="$HOME/.local/bin"
  local npmGlobalBin
  npmGlobalBin="$(userNpmPrefixDirectory)/bin"
  if [[ -d "$userLocalBin" && ":$PATH:" != *":$userLocalBin:"* ]]; then
    PATH="$userLocalBin:$PATH"
  fi
  if [[ -d "$npmGlobalBin" && ":$PATH:" != *":$npmGlobalBin:"* ]]; then
    PATH="$npmGlobalBin:$PATH"
  fi
  export PATH
  hash -r 2>/dev/null || true
}

# Appending to an unterminated last line splices the export onto it.
appendLineToBashrc() {
  local label="$1"
  local exportLine="$2"
  local bashrcPath="$HOME/.bashrc"
  local resolvedPath
  if [[ -L "$bashrcPath" ]]; then
    resolvedPath="$(readlink -f -- "$bashrcPath" 2>/dev/null || true)"
    if [[ "$resolvedPath" != "$HOME/"* ]]; then
      noteWarned "$label" "~/.bashrc resolves outside the home directory, add it by hand"
      return 1
    fi
  fi
  terminateFinalLine "$bashrcPath"
  printf '%s\n' "$exportLine" >> "$bashrcPath"
}

# Pop!_OS ~/.profile adds ~/.local/bin only if it existed at login; installers create it later.
persistUserLocalBinOnPath() {
  if [[ -f "$HOME/.bashrc" ]] && grep -q '\.local/bin' "$HOME/.bashrc"; then
    return 0
  fi
  if ! appendLineToBashrc "~/.bashrc PATH" 'export PATH="$HOME/.local/bin:$PATH"'; then
    return 0
  fi
  noteApplied "~/.bashrc PATH" "added ~/.local/bin"
}

packageNamesForTool() {
  local manager="$1"
  local toolKey="$2"
  case "$toolKey:$manager" in
    git:apt-get | git:dnf | git:pacman | git:zypper)
      printf 'git\n'
      return 0
      ;;
    node:apt-get | node:dnf | node:pacman | node:zypper)
      printf 'nodejs\nnpm\n'
      return 0
      ;;
    python:apt-get | python:dnf | python:zypper)
      printf 'python3\npython3-pip\n'
      return 0
      ;;
    python:pacman)
      printf 'python\npython-pip\n'
      return 0
      ;;
    gh:apt-get | gh:dnf)
      printf 'gh\n'
      return 0
      ;;
    gh:pacman)
      printf 'github-cli\n'
      return 0
      ;;
    solaar:apt-get)
      printf 'solaar\n'
      return 0
      ;;
    ratbagd:apt-get)
      printf 'ratbagd\n'
      return 0
      ;;
    piper:apt-get)
      printf 'piper\n'
      return 0
      ;;
    ghostty:apt-get | ghostty:pacman)
      printf 'ghostty\n'
      return 0
      ;;
    flameshot:apt-get | flameshot:dnf | flameshot:pacman | flameshot:zypper)
      printf 'flameshot\n'
      return 0
      ;;
    wl-clipboard:apt-get | wl-clipboard:dnf | wl-clipboard:pacman | wl-clipboard:zypper)
      printf 'wl-clipboard\n'
      return 0
      ;;
    ydotool:apt-get)
      printf 'ydotool\n'
      return 0
      ;;
    ydotoold:apt-get)
      printf 'ydotoold\n'
      return 0
      ;;
    ydotool:dnf | ydotool:pacman | ydotool:zypper | ydotoold:dnf | ydotoold:pacman | ydotoold:zypper)
      printf 'ydotool\n'
      return 0
      ;;
  esac
  return 1
}

pythonCommandName() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    (
      PATH=/usr/local/bin:/usr/bin:/bin
      hash -r 2>/dev/null || true
      type -P python3 2>/dev/null
    )
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    printf 'python\n'
    return 0
  fi
  return 1
}

pythonHasPip() {
  local pythonCommand
  if ! pythonCommand="$(pythonCommandName)"; then
    return 1
  fi
  "$pythonCommand" -m pip --version >/dev/null 2>&1
}

nodeMajorVersion() {
  local versionText
  if ! versionText="$(node -v 2>/dev/null)"; then
    return 1
  fi
  versionText="${versionText#v}"
  versionText="${versionText%%.*}"
  if [[ ! "$versionText" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$versionText"
}

nodeMinorVersion() {
  local versionText
  if ! versionText="$(node -v 2>/dev/null)"; then
    return 1
  fi
  versionText="${versionText#v}"
  versionText="${versionText#*.}"
  versionText="${versionText%%.*}"
  if [[ ! "$versionText" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$versionText"
}

# The commit skill is TypeScript node runs by stripping types, stable only since 22.18.
nodeIsCurrentEnough() {
  local majorVersion
  local minorVersion
  if ! majorVersion="$(nodeMajorVersion)"; then
    return 1
  fi
  if ((majorVersion > minimumNodeMajor)); then
    return 0
  fi
  if ((majorVersion < minimumNodeMajor)); then
    return 1
  fi
  if ! minorVersion="$(nodeMinorVersion)"; then
    return 1
  fi
  ((minorVersion >= minimumNodeMinor))
}

# A python without pip cannot install ruff, which the validate-file hook needs, so pip counts.
toolIsPresent() {
  local toolKey="$1"
  local commandName="$2"
  if [[ "$toolKey" == "python" ]]; then
    pythonHasPip
    return $?
  fi
  if [[ "$toolKey" == "node" ]]; then
    nodeIsCurrentEnough
    return $?
  fi
  command -v "$commandName" >/dev/null 2>&1
}

installPackageTool() {
  local label="$1"
  local commandName="$2"
  local toolKey="$3"
  local manualSource="${4:-}"
  local manualHint="install manually"
  if [[ -n "$manualSource" ]]; then
    manualHint="install from $manualSource"
  fi
  local manager
  local packageNameArgs=()
  refreshSessionPath
  if toolIsPresent "$toolKey" "$commandName"; then
    notePresent "$label" "already installed"
    return 0
  fi
  if ! manager="$(detectPackageManager)"; then
    noteWarned "$label" "no supported package manager, $manualHint"
    return 0
  fi
  mapfile -t packageNameArgs < <(packageNamesForTool "$manager" "$toolKey" || true)
  if ((${#packageNameArgs[@]} == 0)); then
    noteWarned "$label" "not available via $manager, $manualHint"
    return 0
  fi
  if ! canInstallSystemPackages; then
    noteWarned "$label" "$manager needs root or sudo, $manualHint"
    return 0
  fi
  noteStarting "$label" "installing via $manager"
  if ! installSystemPackages "$manager" "${packageNameArgs[@]}"; then
    noteWarned "$label" "$manager install failed, $manualHint"
    return 0
  fi
  refreshSessionPath
  if toolIsPresent "$toolKey" "$commandName"; then
    noteInstalled "$label" "installed"
    return 0
  fi
  noteWarned "$label" "installed, but open a new shell for PATH"
}

# The script lands on disk first, so nothing pipes the network straight into a root shell.
installFromVendorScript() {
  local label="$1"
  local interpreterCommand="$2"
  local scriptUrl="$3"
  local outputLog="$4"
  local runPrivileged="${5:-0}"
  local scriptPath
  local runner=()
  if ! command -v curl >/dev/null 2>&1; then
    noteWarned "$label" "curl not on PATH, install manually"
    return 1
  fi
  if ((runPrivileged == 1)) && ! canInstallSystemPackages; then
    noteWarned "$label" "needs root or sudo, install manually"
    return 1
  fi
  scriptPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-vendor-install.XXXXXX")"
  if ! curl -fsSL "$scriptUrl" -o "$scriptPath" >>"$outputLog" 2>&1; then
    noteWarned "$label" "installer download failed: $(lastLogLine "$outputLog")"
    rm -f -- "$scriptPath"
    return 1
  fi
  runner=("$interpreterCommand" "$scriptPath")
  if ((runPrivileged == 1)); then
    runner=(runPackageManagerCommand "$interpreterCommand" "$scriptPath")
  fi
  if ! "${runner[@]}" >>"$outputLog" 2>&1; then
    noteWarned "$label" "installer failed: $(lastLogLine "$outputLog")"
    rm -f -- "$scriptPath"
    return 1
  fi
  rm -f -- "$scriptPath"
}

# Only a leading # opens a comment; a later one is a git ref in an npm spec.
readPackageList() {
  local listPath="$1"
  if [[ ! -f "$listPath" ]]; then
    return 0
  fi
  sed '1s/^\xEF\xBB\xBF//' "$listPath" | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'
}

npmPackageName() {
  local packageEntry="$1"
  if [[ "$packageEntry" == *=* ]]; then
    printf '%s\n' "${packageEntry%%=*}"
    return 0
  fi
  printf '%s\n' "$packageEntry"
}

npmPackageSource() {
  local packageEntry="$1"
  if [[ "$packageEntry" == *=* ]]; then
    printf '%s\n' "${packageEntry#*=}"
    return 0
  fi
  printf '%s\n' "$packageEntry"
}

listGlobalNpmPackages() {
  # only lines the strip shortened: the first parseable line is the global root itself
  npm ls -g --depth=0 --parseable 2>/dev/null |
    awk '{ if (sub(/^.*node_modules[\\/]/, "")) { gsub(/\\/, "/"); print } }'
}

npmGlobalRootWritable() {
  local npmGlobalRoot
  npmGlobalRoot="$(npm root -g 2>/dev/null || true)"
  if [[ -z "$npmGlobalRoot" ]]; then
    return 1
  fi
  if [[ -d "$npmGlobalRoot" ]]; then
    [[ -w "$npmGlobalRoot" ]]
    return $?
  fi
  local npmGlobalRootParent
  npmGlobalRootParent="$(dirname -- "$npmGlobalRoot")"
  [[ -d "$npmGlobalRootParent" && -w "$npmGlobalRootParent" ]]
}

currentNpmPrefix() {
  npm config get prefix 2>/dev/null | head -n 1 | tr -d '\r' || true
}

recordNpmPrefixOnLoginPath() {
  if [[ -f "$HOME/.bashrc" ]] && grep -q '\.npm-global/bin' "$HOME/.bashrc"; then
    return 0
  fi
  appendLineToBashrc "npm prefix PATH" 'export PATH="$HOME/.npm-global/bin:$PATH"' || true
}

# npm under sudo breaks native lifecycle builds (node-pty dies with uv_cwd ENOENT).
ensureUserNpmPrefix() {
  if ((userNpmPrefixEnsured == 1)); then
    return 0
  fi
  userNpmPrefixEnsured=1
  if isRoot; then
    return 0
  fi
  local wantedPrefix
  wantedPrefix="$(userNpmPrefixDirectory)"
  if [[ "$(currentNpmPrefix)" == "$wantedPrefix" ]]; then
    mkdir -p -- "$wantedPrefix/bin"
    recordNpmPrefixOnLoginPath
    refreshSessionPath
    return 0
  fi
  if npmGlobalRootWritable; then
    return 0
  fi
  if ! npm config set prefix "$wantedPrefix" >/dev/null 2>&1; then
    noteWarned "npm prefix" "npm config set prefix failed, global installs may hit EACCES"
    return 0
  fi
  mkdir -p -- "$wantedPrefix/bin"
  recordNpmPrefixOnLoginPath
  refreshSessionPath
  noteApplied "npm prefix" "global root not writable, using ~/.npm-global"
}

# A git spec runs its postinstall in a directory npm already moved (ENOENT uv_cwd), so pack first.
installGlobalNpmPackage() {
  local packageSource="$1"
  if [[ "$packageSource" != github:* && "$packageSource" != git+* && "$packageSource" != git:* ]]; then
    runBatchNetworkCommand npm install -g "$packageSource" --loglevel=error
    return $?
  fi
  local packDirectory
  local tarballPath
  local installStatus
  packDirectory="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-npm-pack.XXXXXX")"
  if ! (cd "$packDirectory" && runBatchNetworkCommand npm pack "$packageSource" --loglevel=error >/dev/null); then
    rm -rf -- "$packDirectory"
    return 1
  fi
  tarballPath="$(find "$packDirectory" -maxdepth 1 -name '*.tgz' | head -n 1)"
  if [[ -z "$tarballPath" ]]; then
    rm -rf -- "$packDirectory"
    return 1
  fi
  installStatus=0
  runBatchNetworkCommand npm install -g "$tarballPath" --loglevel=error || installStatus=$?
  rm -rf -- "$packDirectory"
  return $installStatus
}

npmFailureReason() {
  local npmLogPath="$1"
  local reason
  reason="$(grep -E -m1 'EACCES|EPERM|E404|ENOTFOUND|EAI_AGAIN|uv_cwd|code E' "$npmLogPath" 2>/dev/null || true)"
  if [[ -z "$reason" ]]; then
    reason="$(grep -v 'A complete log of this run' "$npmLogPath" 2>/dev/null | awk 'NF { line = $0 } END { print line }')"
  fi
  reason="$(sed -E 's/^npm (error|ERR!) //' <<< "$reason")"
  printf '%.120s\n' "$reason"
}
