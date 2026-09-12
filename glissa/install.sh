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
# shellcheck source=./service.sh
source "$dotfilesRepo/glissa/service.sh"
# shellcheck source=./serve.sh
source "$dotfilesRepo/glissa/serve.sh"

glissaConfigDirectory="$HOME/.glissa"
glissaConfigPath="$glissaConfigDirectory/config.json"
glissaConfigDisplayPath="~/.glissa/config.json"
glissaSecretsPath="$glissaConfigDirectory/secrets.env"
glissaSecretsDisplayPath="~/.glissa/secrets.env"
glissaAppDirectory="$HOME/Projects/glissa"
glissaAppDisplayPath="~/Projects/glissa"
remoteSettingsRewritten=0
resolvedLocalPort=""
resolvedRemotePort=""
selectedGlissaSeedPath=""
selectedGlissaOverlayPath=""
selectedGlissaSeedDescription=""
selectedGlissaWarningDescription=""

glissaProfileSettingsPathFor() {
  printf '%s/profiles/%s/glissa.json\n' "$dotfilesRepo" "$1"
}

profileServesGlissa() {
  local servesSetting
  servesSetting="$(readProfileSetting "$(glissaProfileSettingsPathFor "$1")" serves)" || return 1
  [[ "$servesSetting" == "true" ]]
}

glissaProfileSettingsAreUsable() {
  local settingsPath
  local servesSetting
  if [[ -z "${profileName:-}" ]]; then
    noteWarned "glissa profile" "no profile resolved, config and service skipped"
    return 1
  fi
  settingsPath="$(glissaProfileSettingsPathFor "$profileName")"
  if [[ ! -f "$settingsPath" ]]; then
    noteWarned "glissa profile" "no $settingsPath, config and service skipped"
    return 1
  fi
  servesSetting="$(readProfileSetting "$settingsPath" serves)" || servesSetting=""
  case "$servesSetting" in
    true | false) return 0 ;;
  esac
  noteWarned "glissa profile" "profiles/$profileName/glissa.json has no usable serves setting"
  return 1
}

# A symlinked ~/.glissa points chmod and every write at a path this topic never chose.
glissaConfigDirectoryIsUsable() {
  if [[ -L "$glissaConfigDirectory" ]]; then
    return 1
  fi
  [[ ! -e "$glissaConfigDirectory" ]] || [[ -d "$glissaConfigDirectory" ]]
}

# The seed carries this machine's absolute home, so it is rendered rather than linked.
renderGlissaSeed() {
  local basePath="$1"
  local overlayPath="$2"
  local destinationPath="$3"
  local nodePath
  nodePath="$(resolveGlissaNodePath)" || return 1
  "$nodePath" "$dotfilesRepo/script/lib/merge-json.mjs" \
    "$basePath" "$overlayPath" "$destinationPath" "$HOME"
}

selectGlissaSeedInputs() {
  local baseSeedPath="$1"
  local machineLocalSeed="$2"
  selectedGlissaSeedPath="$baseSeedPath"
  selectedGlissaSeedDescription="config.example.json"
  selectedGlissaOverlayPath=""
  selectedGlissaWarningDescription="config.example.json"
  if [[ -f "$machineLocalSeed" ]]; then
    selectedGlissaSeedPath="$machineLocalSeed"
    selectedGlissaSeedDescription="config.json"
    selectedGlissaWarningDescription=""
    return 0
  fi
  local profileOverlayPath="$dotfilesRepo/profiles/$profileName/glissa.overlay.json"
  if [[ ! -f "$profileOverlayPath" ]]; then
    return 0
  fi
  selectedGlissaOverlayPath="$profileOverlayPath"
  selectedGlissaSeedDescription="config.example.json plus profiles/$profileName/glissa.overlay.json"
  selectedGlissaWarningDescription="profiles/$profileName/glissa.overlay.json"
}

seedGlissaConfig() {
  local label="glissa config"
  local machineLocalSeed
  local baseSeedPath="$dotfilesRepo/glissa/config.example.json"
  local overlayPath
  local seedPath
  local seedDescription
  local seedWarningDescription
  local stagedPath
  machineLocalSeed="$(sandboxRedirectedPath "${DOTFILES_GLISSA_SEED_PATH:-}" \
    "$dotfilesRepo/glissa/config.json")"
  if ! glissaConfigDirectoryIsUsable; then
    noteWarned "$label" "$glissaConfigDisplayPath is not a directory, move it aside first"
    return 0
  fi
  if [[ -f "$glissaConfigPath" && ! -L "$glissaConfigPath" ]]; then
    notePresent "$label" "exists, runtime state kept"
    return 0
  fi
  selectGlissaSeedInputs "$baseSeedPath" "$machineLocalSeed"
  seedPath="$selectedGlissaSeedPath"
  overlayPath="$selectedGlissaOverlayPath"
  seedDescription="$selectedGlissaSeedDescription"
  seedWarningDescription="$selectedGlissaWarningDescription"
  if [[ -n "$seedWarningDescription" ]]; then
    noteWarned "$label" \
      "no glissa/config.json, seeding from $seedWarningDescription (edit repoRoots and projects)"
  fi
  if [[ ! -f "$seedPath" ]]; then
    noteWarned "$label" "missing seed input: $seedPath"
    return 0
  fi
  mkdir -p -- "$glissaConfigDirectory"
  if ! clearDestinationIfNotPlainFile "$label" "$glissaConfigPath"; then
    return 0
  fi
  stagedPath="$(mktemp "$glissaConfigDirectory/.config.json.XXXXXX")"
  chmod 600 -- "$stagedPath"
  if ! renderGlissaSeed "$seedPath" "$overlayPath" "$stagedPath"; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "could not render $seedDescription"
    return 0
  fi
  mv -f -- "$stagedPath" "$glissaConfigPath"
  noteApplied "$label" "seeded from $seedDescription"
}

chmodOwnerOnlyFile() {
  local label="$1" path="$2" displayPath="$3"
  if [[ -f "$path" && ! -L "$path" ]] && ! chmod 600 "$path" 2>/dev/null; then
    noteWarned "$label" "chmod 600 $displayPath failed"
  fi
}

protectGlissaConfig() {
  local label="glissa config perms"
  if ! glissaConfigDirectoryIsUsable; then
    return 0
  fi
  if [[ -d "$glissaConfigDirectory" ]] && ! chmod 700 "$glissaConfigDirectory" 2>/dev/null; then
    noteWarned "$label" "chmod 700 $glissaConfigDisplayPath failed"
  fi
  chmodOwnerOnlyFile "$label" "$glissaConfigPath" "$glissaConfigDisplayPath"
  chmodOwnerOnlyFile "$label" "$glissaSecretsPath" "$glissaSecretsDisplayPath"
}

glissaSecretsFileAssigns() {
  [[ -f "$glissaSecretsPath" ]] || return 1
  local assignedValue
  assignedValue="$(sed -n "s/^[[:space:]]*$1=//p" "$glissaSecretsPath" 2>/dev/null | tail -n 1)"
  assignedValue="${assignedValue#"${assignedValue%%[![:space:]]*}"}"
  assignedValue="${assignedValue%"${assignedValue##*[![:space:]]}"}"
  if [[ ${#assignedValue} -ge 2 && ( "$assignedValue" == \"*\" || "$assignedValue" == \'*\' ) ]]; then
    assignedValue="${assignedValue:1:${#assignedValue}-2}"
  fi
  [[ -n "${assignedValue//[[:space:]]/}" ]]
}

# systemd loads this file into the service and nothing here can supply its values, so naming what is missing is all this topic can do.
reportGlissaSecrets() {
  local label="glissa secrets"
  local variableName
  local missingVariableNames=""
  for variableName in GLISSA_TELEGRAM_BOT_TOKEN GLISSA_POSTHOG_API_KEY; do
    if glissaSecretsFileAssigns "$variableName"; then
      continue
    fi
    missingVariableNames="${missingVariableNames:+$missingVariableNames and }$variableName"
  done
  if [[ -z "$missingVariableNames" ]]; then
    notePresent "$label" "$glissaSecretsDisplayPath carries every variable the unit loads"
    return 0
  fi
  noteWarned "$label" "write $missingVariableNames into $glissaSecretsDisplayPath"
}

requireGlissaApp() {
  if [[ ( -f "$glissaAppDirectory/server/main.ts" || -f "$glissaAppDirectory/server.js" ) \
    && -f "$glissaAppDirectory/package.json" \
    && ( -d "$glissaAppDirectory/.git" || -f "$glissaAppDirectory/.git" ) ]]; then
    notePresent "glissa app" "$glissaAppDisplayPath"
    return 0
  fi
  noteWarned "glissa app" \
    "$glissaAppDisplayPath is not a Glissa checkout, list it in repos/repos.txt so the repos topic clones it"
  return 1
}

readGlissaLocalPort() {
  local nodePath
  nodePath="$(resolveGlissaNodePath)" || return 0
  "$nodePath" -p "String((require(process.argv[1]) || {}).port || '')" "$glissaConfigPath" 2>/dev/null
}

readGlissaRemotePort() {
  local nodePath
  nodePath="$(resolveGlissaNodePath)" || return 0
  "$nodePath" -p "String(((require(process.argv[1]) || {}).remote || {}).port || '')" "$glissaConfigPath" 2>/dev/null
}

readGlissaPublicHost() {
  local nodePath
  nodePath="$(resolveGlissaNodePath)" || return 0
  "$nodePath" -p "String(((require(process.argv[1]) || {}).remote || {}).publicHost || '')" "$glissaConfigPath" 2>/dev/null
}

# A config this run cannot parse is not a config that says "disabled"; conflating them takes a live route down.
readGlissaRemoteState() {
  local stateText
  local nodePath
  if [[ ! -f "$glissaConfigPath" ]] || ! nodePath="$(resolveGlissaNodePath)"; then
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
process.stdout.write(remote.enabled === true ? "enabled" : "disabled");
' "$glissaConfigPath" 2>/dev/null)"; then
    printf 'unreadable\n'
    return 0
  fi
  printf '%s\n' "$stateText"
}

isGlissaRemoteEnabled() {
  [[ "$(readGlissaRemoteState)" == "enabled" ]]
}

glissaConfigIsReadable() {
  if [[ "$(readGlissaRemoteState)" != "unreadable" ]]; then
    return 0
  fi
  noteWarned "glissa config" "$glissaConfigDisplayPath is not valid JSON, service and serve work skipped"
  return 1
}

hasDottedGlissaHost() {
  [[ "$1" == *.* && "$1" != *CHANGEME* ]]
}

isValidGlissaPort() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  (($1 >= 1 && $1 <= 65535))
}

# The local listener is what a machine with remote access turned off still runs, so its port is validated without asking about remote.port.
resolveGlissaLocalPort() {
  local label="glissa config"
  if ! resolveGlissaNodePath >/dev/null; then
    noteWarned "$label" "no node to read $glissaConfigDisplayPath with"
    return 1
  fi
  resolvedLocalPort="$(readGlissaLocalPort)"
  if ! isValidGlissaPort "$resolvedLocalPort"; then
    noteWarned "$label" "set port to 1-65535 in $glissaConfigDisplayPath"
    return 1
  fi
}

resolveGlissaPorts() {
  local label="glissa remote config"
  if ! resolveGlissaLocalPort; then
    return 1
  fi
  resolvedRemotePort="$(readGlissaRemotePort)"
  if ! isValidGlissaPort "$resolvedRemotePort"; then
    noteWarned "$label" "set remote.port to 1-65535 in $glissaConfigDisplayPath"
    return 1
  fi
  if [[ "$resolvedLocalPort" == "$resolvedRemotePort" ]]; then
    noteWarned "$label" "set remote.port to something other than port in $glissaConfigDisplayPath"
    return 1
  fi
}

isTailscaleAuthed() {
  tailscale status >/dev/null 2>&1
}

detectGlissaTailnetHostname() {
  local nodePath
  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi
  if ! nodePath="$(resolveGlissaNodePath)"; then
    return 0
  fi
  if ! isTailscaleAuthed; then
    return 0
  fi
  tailscale status --json 2>/dev/null | "$nodePath" -e 'try { const status = JSON.parse(require("fs").readFileSync(0, "utf8")); const dnsName = String((status.Self || {}).DNSName || "").replace(/\.$/, ""); if (dnsName) process.stdout.write(dnsName); } catch {}' 2>/dev/null || true
}

warnGlissaRemotePlaceholder() {
  noteWarned "glissa remote config" \
    "publicHost still says CHANGEME; authenticate Tailscale (sudo tailscale up) or set remote.publicHost in $glissaConfigDisplayPath"
}

warnGlissaDottedHostRequired() {
  noteWarned "glissa remote config" \
    "publicHost '$1' is not a full tailnet name; set remote.publicHost in $glissaConfigDisplayPath to host.tailnet-name.ts.net"
}

writeGlissaRemoteSettings() {
  local publicHost="$1"
  local nodeStatus=0
  local nodePath
  if ! nodePath="$(resolveGlissaNodePath)"; then
    noteWarned "glissa remote config" "no node to write $glissaConfigDisplayPath with"
    return 1
  fi
  "$nodePath" - "$glissaConfigPath" "$resolvedLocalPort" "$resolvedRemotePort" "$publicHost" <<'NODE' || nodeStatus=$?
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
    protectGlissaConfig
    return 0
  fi
  if ((nodeStatus == 2)); then
    noteWarned "glissa remote config" "config JSON is unreadable, leaving it unchanged"
    return 1
  fi
  noteWarned "glissa remote config" "update failed, leaving it unchanged"
  return 1
}

# Repointing a live dashboard revokes every device already paired against the old name.
reportGlissaRemoteDrift() {
  local detectedHost="$1"
  local label="glissa remote config"
  local configuredHost
  configuredHost="$(readGlissaPublicHost)"
  if ! hasDottedGlissaHost "$configuredHost"; then
    warnGlissaDottedHostRequired "$configuredHost"
    return 0
  fi
  if [[ -z "$detectedHost" || "${configuredHost,,}" == "${detectedHost,,}" ]]; then
    notePresent "$label" "configured"
    return 0
  fi
  noteWarned "$label" \
    "publicHost $configuredHost but the tailnet reports $detectedHost; set remote.publicHost in $glissaConfigDisplayPath"
}

configureGlissaRemoteSettings() {
  local detectedHost
  if ! glissaConfigDirectoryIsUsable; then
    return 0
  fi
  if [[ ! -f "$glissaConfigPath" || -L "$glissaConfigPath" ]]; then
    return 0
  fi
  if ! resolveGlissaNodePath >/dev/null; then
    noteWarned "glissa remote config" "no node in ~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /usr/bin or /bin"
    return 0
  fi
  if ! isGlissaRemoteEnabled; then
    notePresent "glissa remote config" "remote access disabled"
    return 0
  fi
  detectedHost="$(detectGlissaTailnetHostname)"
  if hasDottedGlissaHost "$(readGlissaPublicHost)"; then
    reportGlissaRemoteDrift "$detectedHost"
    return 0
  fi
  if [[ -z "$detectedHost" ]]; then
    warnGlissaRemotePlaceholder
    return 0
  fi
  if ! resolveGlissaPorts; then
    return 0
  fi
  if ! writeGlissaRemoteSettings "$detectedHost"; then
    return 0
  fi
  remoteSettingsRewritten=1
  noteApplied "glissa remote config" "publicHost $detectedHost (detected on the tailnet)"
}

# command -v answers with whatever the converging shell had on PATH; every shell agrees on this.
resolveGlissaNodePath() {
  local candidatePath
  for candidatePath in "$HOME/.npm-global/bin/node" "$HOME/.local/bin/node" \
    /usr/local/bin/node /usr/bin/node /bin/node; do
    if [[ -x "$candidatePath" ]]; then
      printf '%s\n' "$candidatePath"
      return 0
    fi
  done
  return 1
}

probeHttpStatus() {
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")" || return 1
  printf '%s\n' "$status"
}

checkGlissaClaudeState() {
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

noteGlissaPairingChecklist() {
  if ! hasDottedGlissaHost "$(readGlissaPublicHost)"; then
    return 0
  fi
  noteDetail "glissa checklist" "run glissa pair once per device"
}

if ! glissaProfileSettingsAreUsable; then
  finishTopic
fi

if ! glissaConfigDirectoryIsUsable; then
  noteWarned "glissa config" "$glissaConfigDisplayPath is not a directory, move it aside first"
  finishTopic
fi

seedGlissaConfig
protectGlissaConfig

if ! profileServesGlissa "$profileName"; then
  notePresent "glissa service" "skipped, profile does not serve glissa"
  finishTopic
fi

reportGlissaSecrets

if ! requireGlissaApp; then
  finishTopic
fi
if glissaConfigIsReadable; then
  configureGlissaRemoteSettings
  installGlissaService
  configureGlissaServe
  probeGlissaRemoteTls
fi
checkGlissaClaudeState
noteGlissaPairingChecklist

finishTopic
