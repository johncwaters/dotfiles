#!/usr/bin/env bash
# Nothing prompts: a value only its owner can supply is warned about, naming the file to edit.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

# shellcheck source=../script/lib/systemd.sh
source "$dotfilesRepo/script/lib/systemd.sh"
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"
# shellcheck source=../script/lib/launchd.sh
source "$dotfilesRepo/script/lib/launchd.sh"
# shellcheck source=./service.sh
source "$dotfilesRepo/glimmervoid/service.sh"
# shellcheck source=./serve.sh
source "$dotfilesRepo/glimmervoid/serve.sh"

glimmervoidConfigDirectory="$HOME/.glimmervoid"
glimmervoidConfigPath="$glimmervoidConfigDirectory/config.json"
glimmervoidConfigDisplayPath="~/.glimmervoid/config.json"
glimmervoidSecretsPath="$glimmervoidConfigDirectory/secrets.env"
glimmervoidSecretsDisplayPath="~/.glimmervoid/secrets.env"
remoteSettingsRewritten=0
resolvedLocalPort=""
resolvedRemotePort=""
selectedGlimmervoidSeedPath=""
selectedGlimmervoidOverlayPath=""
selectedGlimmervoidSeedDescription=""
selectedGlimmervoidWarningDescription=""

# A symlinked ~/.glimmervoid points chmod and every write at a path this topic never chose.
glimmervoidConfigDirectoryIsUsable() {
  if [[ -L "$glimmervoidConfigDirectory" ]]; then
    return 1
  fi
  [[ ! -e "$glimmervoidConfigDirectory" ]] || [[ -d "$glimmervoidConfigDirectory" ]]
}

# The seed carries this machine's absolute home, so it is rendered rather than linked.
renderGlimmervoidSeed() {
  local basePath="$1"
  local overlayPath="$2"
  local destinationPath="$3"
  local nodePath
  nodePath="$(resolveGlimmervoidNodePath)" || return 1
  "$nodePath" "$dotfilesRepo/script/lib/merge-json.mjs" \
    "$basePath" "$overlayPath" "$destinationPath" "$HOME"
}

selectGlimmervoidSeedInputs() {
  local baseSeedPath="$1"
  local machineLocalSeed="$2"
  selectedGlimmervoidSeedPath="$baseSeedPath"
  selectedGlimmervoidSeedDescription="config.example.json"
  selectedGlimmervoidOverlayPath=""
  selectedGlimmervoidWarningDescription="config.example.json"
  if [[ -f "$machineLocalSeed" ]]; then
    selectedGlimmervoidSeedPath="$machineLocalSeed"
    selectedGlimmervoidSeedDescription="config.json"
    selectedGlimmervoidWarningDescription=""
    return 0
  fi
  local profileOverlayPath="$dotfilesRepo/profiles/$profileName/glimmervoid.overlay.json"
  if [[ ! -f "$profileOverlayPath" ]]; then
    return 0
  fi
  selectedGlimmervoidOverlayPath="$profileOverlayPath"
  selectedGlimmervoidSeedDescription="config.example.json plus profiles/$profileName/glimmervoid.overlay.json"
  selectedGlimmervoidWarningDescription="profiles/$profileName/glimmervoid.overlay.json"
}

seedGlimmervoidConfig() {
  local label="glimmervoid config"
  local machineLocalSeed
  local baseSeedPath="$dotfilesRepo/glimmervoid/config.example.json"
  local overlayPath
  local seedPath
  local seedDescription
  local seedWarningDescription
  local stagedPath
  machineLocalSeed="$(sandboxRedirectedPath "${DOTFILES_GLIMMERVOID_SEED_PATH:-}" \
    "$dotfilesRepo/glimmervoid/config.json")"
  if ! glimmervoidConfigDirectoryIsUsable; then
    noteWarned "$label" "$glimmervoidConfigDisplayPath is not a directory, move it aside first"
    return 0
  fi
  if [[ -f "$glimmervoidConfigPath" && ! -L "$glimmervoidConfigPath" ]]; then
    notePresent "$label" "exists, runtime state kept"
    return 0
  fi
  selectGlimmervoidSeedInputs "$baseSeedPath" "$machineLocalSeed"
  seedPath="$selectedGlimmervoidSeedPath"
  overlayPath="$selectedGlimmervoidOverlayPath"
  seedDescription="$selectedGlimmervoidSeedDescription"
  seedWarningDescription="$selectedGlimmervoidWarningDescription"
  if [[ -n "$seedWarningDescription" ]]; then
    noteWarned "$label" \
      "no glimmervoid/config.json, seeding from $seedWarningDescription (edit repoRoots and projects)"
  fi
  if [[ ! -f "$seedPath" ]]; then
    noteWarned "$label" "missing seed input: $seedPath"
    return 0
  fi
  mkdir -p -- "$glimmervoidConfigDirectory"
  if ! clearDestinationIfNotPlainFile "$label" "$glimmervoidConfigPath"; then
    return 0
  fi
  stagedPath="$(mktemp "$glimmervoidConfigDirectory/.config.json.XXXXXX")"
  chmod 600 "$stagedPath"
  if ! renderGlimmervoidSeed "$seedPath" "$overlayPath" "$stagedPath"; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "could not render $seedDescription"
    return 0
  fi
  mv -f -- "$stagedPath" "$glimmervoidConfigPath"
  noteApplied "$label" "seeded from $seedDescription"
}

copyGlimmervoidSoundsAsRegularFiles() {
  local soundSourcePath
  local soundFileName
  for soundSourcePath in "$dotfilesRepo"/glimmervoid/sounds/*; do
    if [[ ! -f "$soundSourcePath" ]]; then
      continue
    fi
    soundFileName="$(basename -- "$soundSourcePath")"
    copyEntry "glimmervoid sound $soundFileName" "glimmervoid/sounds/$soundFileName" \
      "$glimmervoidConfigDirectory/sounds/$soundFileName"
  done
}

chmodOwnerOnlyFile() {
  local label="$1" path="$2" displayPath="$3"
  if [[ -f "$path" && ! -L "$path" ]] && ! chmod 600 "$path" 2>/dev/null; then
    noteWarned "$label" "chmod 600 $displayPath failed"
  fi
}

protectGlimmervoidConfig() {
  local label="glimmervoid config perms"
  if ! glimmervoidConfigDirectoryIsUsable; then
    return 0
  fi
  if [[ -d "$glimmervoidConfigDirectory" ]] && ! chmod 700 "$glimmervoidConfigDirectory" 2>/dev/null; then
    noteWarned "$label" "chmod 700 $glimmervoidConfigDisplayPath failed"
  fi
  chmodOwnerOnlyFile "$label" "$glimmervoidConfigPath" "$glimmervoidConfigDisplayPath"
  chmodOwnerOnlyFile "$label" "$glimmervoidSecretsPath" "$glimmervoidSecretsDisplayPath"
}

glimmervoidSecretsFileAssigns() {
  [[ -f "$glimmervoidSecretsPath" ]] || return 1
  local assignedValue
  assignedValue="$(sed -n "s/^[[:space:]]*$1=//p" "$glimmervoidSecretsPath" 2>/dev/null | tail -n 1)"
  assignedValue="${assignedValue#"${assignedValue%%[![:space:]]*}"}"
  assignedValue="${assignedValue%"${assignedValue##*[![:space:]]}"}"
  if [[ ${#assignedValue} -ge 2 && ( "$assignedValue" == \"*\" || "$assignedValue" == \'*\' ) ]]; then
    assignedValue="${assignedValue:1:${#assignedValue}-2}"
  fi
  [[ -n "${assignedValue//[[:space:]]/}" ]]
}

# systemd loads this file into the service and nothing here can supply its values, so naming what is missing is all this topic can do.
reportGlimmervoidSecrets() {
  local label="glimmervoid secrets"
  local variableName
  local missingVariableNames=""
  for variableName in GLIMMERVOID_TELEGRAM_BOT_TOKEN GLIMMERVOID_POSTHOG_API_KEY; do
    if glimmervoidSecretsFileAssigns "$variableName"; then
      continue
    fi
    missingVariableNames="${missingVariableNames:+$missingVariableNames and }$variableName"
  done
  if [[ -z "$missingVariableNames" ]]; then
    notePresent "$label" "$glimmervoidSecretsDisplayPath carries every variable the unit loads"
    return 0
  fi
  noteWarned "$label" "write $missingVariableNames into $glimmervoidSecretsDisplayPath"
}

readGlimmervoidLocalPort() {
  local nodePath
  nodePath="$(resolveGlimmervoidNodePath)" || return 0
  "$nodePath" -p "String((require(process.argv[1]) || {}).port || '')" "$glimmervoidConfigPath" 2>/dev/null
}

readGlimmervoidRemotePort() {
  local nodePath
  nodePath="$(resolveGlimmervoidNodePath)" || return 0
  "$nodePath" -p "String(((require(process.argv[1]) || {}).remote || {}).port || '')" "$glimmervoidConfigPath" 2>/dev/null
}

readGlimmervoidPublicHost() {
  local nodePath
  nodePath="$(resolveGlimmervoidNodePath)" || return 0
  "$nodePath" -p "String(((require(process.argv[1]) || {}).remote || {}).publicHost || '')" "$glimmervoidConfigPath" 2>/dev/null
}

# A config this run cannot parse is not a config that says "disabled"; conflating them takes a live route down.
readGlimmervoidRemoteState() {
  local stateText
  local nodePath
  if [[ ! -f "$glimmervoidConfigPath" ]] || ! nodePath="$(resolveGlimmervoidNodePath)"; then
    printf 'unknown\n'
    return 0
  fi
  if ! stateText="$("$nodePath" -e '
const requireObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(2);
  return value;
};
let config;
try {
  config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
} catch {
  process.exit(2);
}
requireObject(config);
const remote = config.remote === undefined ? {} : requireObject(config.remote);
process.stdout.write(typeof remote.publicHost === "string" && remote.publicHost !== "" ? "enabled" : "disabled");
' "$glimmervoidConfigPath" 2>/dev/null)"; then
    printf 'unreadable\n'
    return 0
  fi
  printf '%s\n' "$stateText"
}

isGlimmervoidRemoteEnabled() {
  [[ "$(readGlimmervoidRemoteState)" == "enabled" ]]
}

glimmervoidConfigIsReadable() {
  if [[ "$(readGlimmervoidRemoteState)" != "unreadable" ]]; then
    return 0
  fi
  noteWarned "glimmervoid config" "$glimmervoidConfigDisplayPath is not valid JSON, service and serve work skipped"
  return 1
}

hasDottedGlimmervoidHost() {
  [[ "$1" == *.* && "$1" != *CHANGEME* ]]
}

isValidGlimmervoidPort() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  (($1 >= 1 && $1 <= 65535))
}

# The local listener is what a machine not published on the tailnet still runs, so its port is validated without asking about remote.port.
resolveGlimmervoidLocalPort() {
  local label="glimmervoid config"
  if ! resolveGlimmervoidNodePath >/dev/null; then
    noteWarned "$label" "no node to read $glimmervoidConfigDisplayPath with"
    return 1
  fi
  resolvedLocalPort="$(readGlimmervoidLocalPort)"
  if ! isValidGlimmervoidPort "$resolvedLocalPort"; then
    noteWarned "$label" "set port to 1-65535 in $glimmervoidConfigDisplayPath"
    return 1
  fi
}

resolveGlimmervoidPorts() {
  local label="glimmervoid remote config"
  if ! resolveGlimmervoidLocalPort; then
    return 1
  fi
  resolvedRemotePort="$(readGlimmervoidRemotePort)"
  if ! isValidGlimmervoidPort "$resolvedRemotePort"; then
    noteWarned "$label" "set remote.port to 1-65535 in $glimmervoidConfigDisplayPath"
    return 1
  fi
  if [[ "$resolvedLocalPort" == "$resolvedRemotePort" ]]; then
    noteWarned "$label" "set remote.port to something other than port in $glimmervoidConfigDisplayPath"
    return 1
  fi
}

isTailscaleAuthed() {
  tailscale status >/dev/null 2>&1
}

detectGlimmervoidTailnetHostname() {
  local nodePath
  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    return 0
  fi
  if ! isTailscaleAuthed; then
    return 0
  fi
  tailscale status --json 2>/dev/null | "$nodePath" -e 'try { const status = JSON.parse(require("fs").readFileSync(0, "utf8")); const dnsName = String((status.Self || {}).DNSName || "").replace(/\.$/, ""); if (dnsName) process.stdout.write(dnsName); } catch {}' 2>/dev/null || true
}

warnGlimmervoidRemotePlaceholder() {
  noteWarned "glimmervoid remote config" \
    "publicHost still says CHANGEME; authenticate Tailscale (sudo tailscale up) or set remote.publicHost in $glimmervoidConfigDisplayPath"
}

warnGlimmervoidDottedHostRequired() {
  noteWarned "glimmervoid remote config" \
    "publicHost '$1' is not a full tailnet name; set remote.publicHost in $glimmervoidConfigDisplayPath to host.tailnet-name.ts.net"
}

writeGlimmervoidRemoteSettings() {
  local publicHost="$1"
  local nodeStatus=0
  local nodePath
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    noteWarned "glimmervoid remote config" "no node to write $glimmervoidConfigDisplayPath with"
    return 1
  fi
  "$nodePath" - "$glimmervoidConfigPath" "$resolvedLocalPort" "$resolvedRemotePort" "$publicHost" <<'NODE' || nodeStatus=$?
const fs = require("fs");
const path = require("path");

const [configPath, localPortText, remotePortText, publicHost] = process.argv.slice(2);
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(2);
}

config.port = Number(localPortText);
config.remote = config.remote && typeof config.remote === "object" ? config.remote : {};
config.remote.port = Number(remotePortText);
config.remote.publicHost = publicHost;
config.remote.allowedOrigins = [`https://${publicHost}`];

const tempPath = path.join(path.dirname(configPath), `.config.json.${process.pid}.tmp`);
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tempPath, configPath);
NODE
  if ((nodeStatus == 0)); then
    protectGlimmervoidConfig
    return 0
  fi
  if ((nodeStatus == 2)); then
    noteWarned "glimmervoid remote config" "config JSON is unreadable, leaving it unchanged"
    return 1
  fi
  noteWarned "glimmervoid remote config" "update failed, leaving it unchanged"
  return 1
}

# Repointing a live dashboard revokes every device already paired against the old name.
reportGlimmervoidRemoteDrift() {
  local detectedHost="$1"
  local label="glimmervoid remote config"
  local configuredHost
  configuredHost="$(readGlimmervoidPublicHost)"
  if ! hasDottedGlimmervoidHost "$configuredHost"; then
    warnGlimmervoidDottedHostRequired "$configuredHost"
    return 0
  fi
  if [[ -z "$detectedHost" || "${configuredHost,,}" == "${detectedHost,,}" ]]; then
    notePresent "$label" "configured"
    return 0
  fi
  noteWarned "$label" \
    "publicHost $configuredHost but the tailnet reports $detectedHost; set remote.publicHost in $glimmervoidConfigDisplayPath"
}

configureGlimmervoidRemoteSettings() {
  local detectedHost
  if ! glimmervoidConfigDirectoryIsUsable; then
    return 0
  fi
  if [[ ! -f "$glimmervoidConfigPath" || -L "$glimmervoidConfigPath" ]]; then
    return 0
  fi
  if ! resolveGlimmervoidNodePath >/dev/null; then
    noteWarned "glimmervoid remote config" "$(describeGlimmervoidNodeSearch)"
    return 0
  fi
  if ! isGlimmervoidRemoteEnabled; then
    notePresent "glimmervoid remote config" "not published on the tailnet"
    return 0
  fi
  detectedHost="$(detectGlimmervoidTailnetHostname)"
  if hasDottedGlimmervoidHost "$(readGlimmervoidPublicHost)"; then
    reportGlimmervoidRemoteDrift "$detectedHost"
    return 0
  fi
  if [[ -z "$detectedHost" ]]; then
    warnGlimmervoidRemotePlaceholder
    return 0
  fi
  if ! resolveGlimmervoidPorts; then
    return 0
  fi
  if ! writeGlimmervoidRemoteSettings "$detectedHost"; then
    return 0
  fi
  remoteSettingsRewritten=1
  noteApplied "glimmervoid remote config" "publicHost $detectedHost (detected on the tailnet)"
}

# command -v answers with whatever the converging shell had on PATH; every shell agrees on this.
# Homebrew comes before /usr/local/bin because on a silicon mac it holds the only node, and on an intel mac its prefix IS /usr/local.
resolveGlimmervoidNodePath() {
  local candidatePath
  for candidatePath in "$HOME/.npm-global/bin/node" "$HOME/.local/bin/node" \
    "$(homebrewPrefix)/bin/node" /usr/local/bin/node /usr/bin/node /bin/node; do
    if [[ -x "$candidatePath" ]]; then
      printf '%s\n' "$candidatePath"
      return 0
    fi
  done
  return 1
}

describeGlimmervoidNodeSearch() {
  printf 'no node in ~/.npm-global/bin, ~/.local/bin, %s/bin, /usr/local/bin, /usr/bin or /bin\n' \
    "$(homebrewPrefix)"
}

probeHttpStatus() {
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")" || return 1
  printf '%s\n' "$status"
}

checkGlimmervoidClaudeState() {
  local label="claude"
  if ! command -v claude >/dev/null 2>&1; then
    noteWarned "$label" "not on PATH, add \$HOME/.local/bin to PATH"
    return 0
  fi
  if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
    noteWarned "$label" "run claude login on this machine"
    return 0
  fi
  notePresent "$label" "installed and logged in"
}

noteGlimmervoidPairingChecklist() {
  if ! hasDottedGlimmervoidHost "$(readGlimmervoidPublicHost)"; then
    return 0
  fi
  noteDetail "glimmervoid checklist" "run glimmervoid pair once per device"
}

glimmervoidBinaryPath="$HOME/.glimmervoid/bin/glimmervoid"
glimmervoidInstallerUrl="${DOTFILES_GLIMMERVOID_INSTALLER_URL:-https://github.com/johncwaters/glimmervoid/releases/latest/download/glimmervoid-installer.sh}"

glimmervoidUpdaterPath="$HOME/.glimmervoid/bin/glimmervoid-update"

# The installer moves the new binary into place, so the running server keeps its old one until its next restart; the 04:00 converge never restarts it.
updateGlimmervoidBinary() {
  local label="glimmervoid binary"
  local versionBefore versionAfter updaterLog
  versionBefore="$("$glimmervoidBinaryPath" --version 2>/dev/null || printf 'unknown')"
  if [[ ! -x "$glimmervoidUpdaterPath" ]]; then
    noteWarned "$label" "$versionBefore; no ~/.glimmervoid/bin/glimmervoid-update to check for a newer release"
    return 0
  fi
  updaterLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-glimmervoid-update.XXXXXX")"
  if ! GLIMMERVOID_INSTALL_DIR= CARGO_DIST_FORCE_INSTALL_DIR= GLIMMERVOID_UNMANAGED_INSTALL= GLIMMERVOID_NO_MODIFY_PATH=1 \
    "$glimmervoidUpdaterPath" >"$updaterLog" 2>&1 </dev/null; then
    noteWarned "$label" "update check failed, keeping $versionBefore: $(lastLogLine "$updaterLog")"
    rm -f -- "$updaterLog"
    return 0
  fi
  rm -f -- "$updaterLog"
  versionAfter="$("$glimmervoidBinaryPath" --version 2>/dev/null || printf 'unknown')"
  if [[ "$versionAfter" == "$versionBefore" ]]; then
    notePresent "$label" "$versionAfter"
    return 0
  fi
  noteInstalled "$label" "$versionBefore -> $versionAfter; the running server picks it up on its next restart"
}

installGlimmervoidBinary() {
  local label="glimmervoid binary"
  local installerLog
  if [[ -x "$glimmervoidBinaryPath" ]]; then
    updateGlimmervoidBinary
    return 0
  fi
  noteStarting "$label" "running the release installer"
  installerLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-glimmervoid-install.XXXXXX")"
  # Without it the installer appends to ~/.bashrc and ~/.bash_profile, which are stubs this repo owns.
  if ! GLIMMERVOID_INSTALL_DIR= CARGO_DIST_FORCE_INSTALL_DIR= GLIMMERVOID_UNMANAGED_INSTALL= GLIMMERVOID_NO_MODIFY_PATH=1 installFromVendorScript "$label" sh "$glimmervoidInstallerUrl" "$installerLog"; then
    rm -f -- "$installerLog"
    return 1
  fi
  rm -f -- "$installerLog"
  if [[ ! -x "$glimmervoidBinaryPath" ]]; then
    noteWarned "$label" "installer ran but left no ~/.glimmervoid/bin/glimmervoid"
    return 1
  fi
  noteInstalled "$label" "$("$glimmervoidBinaryPath" --version 2>/dev/null || printf 'installed')"
}

applyGlimmervoidSharedSettings() {
  local label="glimmervoid settings"
  local nodePath settingsSyncOutput settingsSyncErrorPath settingsSyncReason=""
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    noteWarned "$label" "$(describeGlimmervoidNodeSearch)"
    return 0
  fi
  if ! settingsSyncErrorPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-glimmervoid-settings.XXXXXX")"; then
    noteWarned "$label" "cannot create a scratch file; shared settings not applied"
    return 0
  fi
  if ! settingsSyncOutput="$("$nodePath" "$dotfilesRepo/glimmervoid/sync-settings.mjs" apply \
    "$glimmervoidConfigPath" "$dotfilesRepo/glimmervoid/settings.json" \
    "$glimmervoidConfigDirectory/dotfiles-settings-base.json" "$HOME" 2> "$settingsSyncErrorPath")"; then
    settingsSyncReason="$(sed -nE 's/^[A-Za-z]*Error: //p' "$settingsSyncErrorPath" | head -n 1)"
    rm -f -- "$settingsSyncErrorPath"
    [[ -z "$settingsSyncOutput" ]] || printf '%s\n' "$settingsSyncOutput"
    noteWarned "$label" "not applied: ${settingsSyncReason:-sync-settings failed}"
    return 0
  fi
  rm -f -- "$settingsSyncErrorPath"
  printf '%s\n' "$settingsSyncOutput"
  if [[ "$settingsSyncOutput" == *'[warned]'* ]]; then
    noteWarned "$label" "see [warned] lines"
  fi
}

if [[ -z "${profileName:-}" ]]; then
  noteWarned "glimmervoid profile" "no profile resolved, config and service skipped"
  finishTopic
fi

if ! glimmervoidConfigDirectoryIsUsable; then
  noteWarned "glimmervoid config" "$glimmervoidConfigDisplayPath is not a directory, move it aside first"
  finishTopic
fi

if [[ "$profileName" != work ]]; then
  seedGlimmervoidConfig
fi
applyGlimmervoidSharedSettings
copyGlimmervoidSoundsAsRegularFiles
protectGlimmervoidConfig

# The CLI is how a machine uses Glimmervoid, which is independent of whether that machine serves one.
glimmervoidBinaryIsInstalled=0
if installGlimmervoidBinary; then
  glimmervoidBinaryIsInstalled=1
fi

reportGlimmervoidSecrets

# A failed install leaves the running service and its files as they were, so the next converge can retry the cutover.
if ((glimmervoidBinaryIsInstalled == 0)); then
  notePresent "glimmervoid service" "left as it was until ~/.glimmervoid/bin/glimmervoid installs"
  finishTopic
fi

# The devbox carries remote access and pairing, so a Mac serves only its own local dashboard.
if isDarwin; then
  installDarwinLaunchAgent "glimmervoid service" dev.dotfiles.glimmervoid \
    "$dotfilesRepo/glimmervoid/dotfiles-glimmervoid.plist.template" || true
  finishTopic
fi

if glimmervoidConfigIsReadable; then
  configureGlimmervoidRemoteSettings
  installGlimmervoidService
  configureGlimmervoidServe
  probeGlimmervoidRemoteTls
fi
checkGlimmervoidClaudeState
noteGlimmervoidPairingChecklist

finishTopic
