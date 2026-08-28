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

glissaConfigDirectory="$HOME/.glissa"
glissaConfigPath="$glissaConfigDirectory/config.json"
glissaConfigDisplayPath="~/.glissa/config.json"
glissaAppDirectory="$HOME/Projects/glissa"
glissaAppDisplayPath="~/Projects/glissa"
systemdUserDirectory="$HOME/.config/systemd/user"
glissaUnitPath="$systemdUserDirectory/glissa.service"
remoteSettingsRewritten=0
tailnetServeStarted=0
resolvedLocalPort=""
resolvedRemotePort=""
glissaServeHttpsPort=443
glissaServeWithdrawalStateName="glissa-serve-withdrawal-pending"
glissaServeOwnedStateName="glissa-serve-owned"
glissaServiceInputsStateName="glissa-service-inputs-record"
glissaServeQueryFailed=2
glissaServeQueryNodeMissing=3
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

sedReplacementFor() {
  printf '%s' "$1" | sed -e 's|[/&\]|\\&|g'
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

protectGlissaConfig() {
  local label="glissa config perms"
  if ! glissaConfigDirectoryIsUsable; then
    return 0
  fi
  if [[ -d "$glissaConfigDirectory" ]] && ! chmod 700 "$glissaConfigDirectory" 2>/dev/null; then
    noteWarned "$label" "chmod 700 $glissaConfigDisplayPath failed"
  fi
  if [[ -f "$glissaConfigPath" && ! -L "$glissaConfigPath" ]] \
    && ! chmod 600 "$glissaConfigPath" 2>/dev/null; then
    noteWarned "$label" "chmod 600 $glissaConfigDisplayPath failed"
  fi
}

requireGlissaApp() {
  if [[ -f "$glissaAppDirectory/server.js" && -f "$glissaAppDirectory/package.json" \
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
process.stdout.write(remote.enabled === false ? "disabled" : "enabled");
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
if (config.remote.enabled === undefined) {
  config.remote.enabled = true;
}
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

# Splicing the ambient PATH in makes the unit differ between converging shells, and every difference restarts the live service.
glissaUnitSearchPath() {
  local nodeDirectory="$1"
  local candidateDirectory
  local searchPath=""
  for candidateDirectory in "$nodeDirectory" "$HOME/.npm-global/bin" "$HOME/.local/bin" \
    /usr/local/bin /usr/bin /bin; do
    if [[ ":$searchPath:" == *":$candidateDirectory:"* ]]; then
      continue
    fi
    searchPath="${searchPath:+$searchPath:}$candidateDirectory"
  done
  printf '%s\n' "$searchPath"
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

renderGlissaUnit() {
  local templatePath="$1"
  local destinationPath="$2"
  local nodePath="$3"
  local unitPath
  unitPath="$(glissaUnitSearchPath "$(dirname -- "$nodePath")")"
  sed \
    -e "s/__NODE__/$(sedReplacementFor "$nodePath")/g" \
    -e "s/__APP_DIR__/$(sedReplacementFor "$glissaAppDirectory")/g" \
    -e "s/__PATH__/$(sedReplacementFor "$unitPath")/g" \
    "$templatePath" > "$destinationPath"
}

enableGlissaLinger() {
  local label="glissa linger"
  local accountName
  accountName="$(id -un)"
  if ! command -v loginctl >/dev/null 2>&1; then
    noteWarned "$label" "loginctl not on PATH"
    return 0
  fi
  if loginctl show-user "$accountName" -p Linger --value 2>/dev/null | grep -qx yes; then
    notePresent "$label" "enabled"
    return 0
  fi
  if loginctl --no-ask-password enable-linger "$accountName" >/dev/null 2>&1; then
    noteApplied "$label" "enabled"
    return 0
  fi
  noteWarned "$label" "run: loginctl enable-linger $accountName"
}

# The server reads its config and the app code only at boot, and neither changes the unit file.
glissaServiceInputsToken() {
  local configToken="absent"
  local checkoutToken="absent"
  if [[ -f "$glissaConfigPath" ]]; then
    configToken="$(cksum < "$glissaConfigPath")"
  fi
  if command -v git >/dev/null 2>&1; then
    checkoutToken="$(git -C "$glissaAppDirectory" rev-parse HEAD 2>/dev/null || true)"
  fi
  printf 'config %s\ncheckout %s\n' "$configToken" "$checkoutToken"
}

glissaServiceInputsChanged() {
  local recordedInputs
  if ! recordedInputs="$(readDotfilesState "$glissaServiceInputsStateName")"; then
    return 0
  fi
  [[ "$recordedInputs" != "$(glissaServiceInputsToken)" ]]
}

recordGlissaServiceInputs() {
  writeDotfilesState "$glissaServiceInputsStateName" "$(glissaServiceInputsToken)"
}

glissaAppDepsArePending() {
  dotfilesStateIsPending "$(repoDepsPendingStateNameForPath "$glissaAppDirectory")"
}

startGlissaService() {
  local unitChanged="$1"
  local label="glissa service"
  if glissaAppDepsArePending; then
    noteWarned "$label" \
      "dependencies or build are pending for $glissaAppDisplayPath, run the repos topic before starting it"
    return 1
  fi
  if ! userServiceManagerIsReachable; then
    noteWarned "$label" "user service manager not reachable, unit installed but not started"
    return 1
  fi
  if ((remoteSettingsRewritten == 1)) || glissaServiceInputsChanged; then
    unitChanged=1
  fi
  if ! enableUserService "$label" "glissa" "$unitChanged"; then
    return 1
  fi
  recordGlissaServiceInputs
}

installGlissaService() {
  local label="glissa service"
  local templatePath="$dotfilesRepo/glissa/glissa.service"
  local nodePath
  local stagedUnit
  local unitChanged=0
  if ! command -v systemctl >/dev/null 2>&1; then
    noteWarned "$label" "systemctl not on PATH, service skipped"
    return 0
  fi
  if [[ ! -f "$templatePath" ]]; then
    noteWarned "$label" "template not in repo"
    return 0
  fi
  if ! nodePath="$(resolveGlissaNodePath)"; then
    noteWarned "$label" "no node in ~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /usr/bin or /bin"
    return 0
  fi
  mkdir -p -- "$systemdUserDirectory"
  if ! clearDestinationIfNotPlainFile "$label" "$glissaUnitPath"; then
    return 0
  fi
  stagedUnit="$(mktemp "$systemdUserDirectory/.glissa.service.XXXXXX")"
  renderGlissaUnit "$templatePath" "$stagedUnit" "$nodePath"
  if commitRenderedFile "$label" "$stagedUnit" "$glissaUnitPath"; then
    unitChanged=1
    noteApplied "$label" "installed"
  fi
  if ((unitChanged == 0)); then
    notePresent "$label" "up to date"
  fi
  if ! startGlissaService "$unitChanged"; then
    return 0
  fi
  probeGlissaServiceHealth
  enableGlissaLinger
}

probeHttpStatus() {
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")" || return 1
  printf '%s\n' "$status"
}

probeGlissaHttp() {
  local label="$1"
  local url="$2"
  local expectedStatus="$3"
  local successNote="$4"
  local attempt
  local httpStatus
  noteStarting "$label" "waiting for HTTP $expectedStatus from $url"
  for attempt in {1..20}; do
    if httpStatus="$(probeHttpStatus "$url")" && [[ "$httpStatus" == "$expectedStatus" ]]; then
      notePresent "$label" "$successNote"
      return 0
    fi
    sleep 0.5
  done
  noteWarned "$label" "no HTTP $expectedStatus from $url, run: journalctl --user -u glissa -n 20"
}

probeGlissaServiceHealth() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if ! resolveGlissaLocalPort; then
    return 0
  fi
  probeGlissaHttp "glissa health" "http://127.0.0.1:$resolvedLocalPort/" "200" "local listener serving"
  if ! isGlissaRemoteEnabled; then
    return 0
  fi
  if ! resolveGlissaPorts; then
    return 0
  fi
  probeGlissaHttp "glissa remote health" "http://127.0.0.1:$resolvedRemotePort/" "401" "remote listener auth-gated"
}

# The text status gives no way to tell which https port a handler belongs to, and an exit status is the only way to tell an empty route from a question this run could not ask.
glissaServeBackendsOnHttpsPort() {
  local statusJson
  local nodePath
  if ! nodePath="$(resolveGlissaNodePath)"; then
    return "$glissaServeQueryNodeMissing"
  fi
  if ! statusJson="$(tailscale serve status --json 2>/dev/null)"; then
    return "$glissaServeQueryFailed"
  fi
  printf '%s' "$statusJson" | "$nodePath" -e '
const wantedPort = process.argv[1];
const requireObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(2);
  return value;
};
let config;
try {
  const rawStatus = require("fs").readFileSync(0, "utf8").trim();
  if (rawStatus === "") process.exit(2);
  config = JSON.parse(rawStatus);
} catch {
  process.exit(2);
}
requireObject(config);
const webByHostPort = config.Web === undefined ? {} : requireObject(config.Web);
const backends = [];
for (const hostPort of Object.keys(webByHostPort)) {
  if (!hostPort.endsWith(`:${wantedPort}`)) continue;
  const handlers = requireObject(webByHostPort[hostPort]).Handlers;
  const handlersByPath = handlers === undefined ? {} : requireObject(handlers);
  for (const routePath of Object.keys(handlersByPath)) {
    const handler = requireObject(handlersByPath[routePath]);
    backends.push(handler.Proxy ? String(handler.Proxy) : "not a proxy");
  }
}
process.stdout.write(backends.join("\n"));
' "$glissaServeHttpsPort" 2>/dev/null || return "$glissaServeQueryFailed"
}

glissaServeQueryFailureReason() {
  if (($1 == glissaServeQueryNodeMissing)); then
    printf 'no node to read the serve status with\n'
    return 0
  fi
  printf 'tailscale serve status --json failed\n'
}

backendTargetsLocalPort() {
  local backend="$1"
  local wantedPort="${2:-}"
  local localHost
  for localHost in 127.0.0.1 localhost; do
    if [[ -n "$wantedPort" && "$backend" == "http://$localHost:$wantedPort" ]]; then
      return 0
    fi
    if [[ -z "$wantedPort" && "$backend" == http://"$localHost":* ]]; then
      return 0
    fi
  done
  return 1
}

everyBackendTargetsPort() {
  local backends="$1"
  local wantedPort="$2"
  local backend
  local sawAnyBackend=0
  while IFS= read -r backend || [[ -n "$backend" ]]; do
    if [[ -z "$backend" ]]; then
      continue
    fi
    sawAnyBackend=1
    if ! backendTargetsLocalPort "$backend" "$wantedPort"; then
      return 1
    fi
  done <<< "$backends"
  ((sawAnyBackend == 1))
}

recordGlissaServeOwnership() {
  writeDotfilesState "$glissaServeOwnedStateName" "$1"
}

# What this topic published is what it may withdraw; no record means no route is owned.
glissaServeOwnedPort() {
  local ownedPort
  ownedPort="$(readDotfilesState "$glissaServeOwnedStateName")" || ownedPort=""
  printf '%s\n' "${ownedPort%%$'\n'*}"
}

glissaServeWithdrawalIsPending() {
  dotfilesStateIsPending "$glissaServeWithdrawalStateName"
}

attemptGlissaServeWithdrawal() {
  local label="$1"
  markDotfilesStatePending "$glissaServeWithdrawalStateName"
  if ! tailscale serve --https="$glissaServeHttpsPort" off >/dev/null 2>&1; then
    noteWarned "$label" \
      "remote is disabled but the route could not be withdrawn, run: tailscale serve --https=$glissaServeHttpsPort off"
    return 1
  fi
  clearDotfilesState "$glissaServeWithdrawalStateName"
  clearDotfilesState "$glissaServeOwnedStateName"
  noteApplied "$label" "route removed, glissa remote disabled"
}

# A route left up keeps every paired device's tailnet access whatever backend port it names now, so only a status this run actually parsed authorises taking one down; "serve --https=<port> off" is the CLI's own name for this.
withdrawGlissaServe() {
  local label="$1"
  local backends
  local queryStatus=0
  if ! isTailscaleAuthed; then
    markDotfilesStatePending "$glissaServeWithdrawalStateName"
    noteWarned "$label" \
      "tailscale is not authenticated, so the route on $glissaServeHttpsPort cannot be checked before withdrawal; run sudo tailscale up, then tailscale serve --https=$glissaServeHttpsPort off"
    return 0
  fi
  backends="$(glissaServeBackendsOnHttpsPort)" || queryStatus=$?
  if ((queryStatus != 0)); then
    markDotfilesStatePending "$glissaServeWithdrawalStateName"
    noteWarned "$label" \
      "$(glissaServeQueryFailureReason "$queryStatus"), run: tailscale serve --https=$glissaServeHttpsPort off"
    return 0
  fi
  if [[ -z "$backends" ]]; then
    clearDotfilesState "$glissaServeWithdrawalStateName"
    clearDotfilesState "$glissaServeOwnedStateName"
    notePresent "$label" "skipped, glissa remote disabled"
    return 0
  fi
  if ! everyBackendTargetsPort "$backends" ""; then
    noteWarned "$label" \
      "port $glissaServeHttpsPort proxies something other than a local backend, leaving it up"
    return 0
  fi
  if ! glissaServeRouteIsOursToReplace "$backends"; then
    noteWarned "$label" "$(glissaServeNotOursReason)"
    return 0
  fi
  attemptGlissaServeWithdrawal "$label" || true
}

# Without HTTPS enabled on the tailnet this asks for consent on stdin, and a converge has nobody to answer it; unbounded, it would hang the whole run instead.
publishGlissaServeRoute() {
  local remotePort="$1"
  local publishStatus=0
  timeout 30 tailscale serve --bg "$remotePort" </dev/null >/dev/null 2>&1 || publishStatus=$?
  return "$publishStatus"
}

glissaServeNotOursReason() {
  local ownedPort
  ownedPort="$(glissaServeOwnedPort)"
  if ! isValidGlissaPort "$ownedPort"; then
    printf 'port %s proxies a backend this topic has no record of publishing, leaving it up\n' \
      "$glissaServeHttpsPort"
    return 0
  fi
  printf 'port %s proxies a local backend other than the port %s this topic published, leaving it up\n' \
    "$glissaServeHttpsPort" "$ownedPort"
}

# An empty 443 is free to take; anything else on it may be replaced only if it is the backend this topic recorded publishing.
glissaServeRouteIsOursToReplace() {
  local backends="$1"
  local ownedPort
  if [[ -z "$backends" ]]; then
    return 0
  fi
  ownedPort="$(glissaServeOwnedPort)"
  if ! isValidGlissaPort "$ownedPort"; then
    return 1
  fi
  everyBackendTargetsPort "$backends" "$ownedPort"
}

# Serving the local port instead of remote.port exposes the dashboard unauthenticated.
publishGlissaServe() {
  local label="$1"
  local backends
  local queryStatus=0
  if ! resolveGlissaPorts; then
    return 0
  fi
  if ! isTailscaleAuthed; then
    noteWarned "$label" "run sudo tailscale up once, then tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  backends="$(glissaServeBackendsOnHttpsPort)" || queryStatus=$?
  if ((queryStatus != 0)); then
    noteWarned "$label" \
      "$(glissaServeQueryFailureReason "$queryStatus"), leaving the route alone; run: tailscale serve status --json"
    return 0
  fi
  if everyBackendTargetsPort "$backends" "$resolvedRemotePort"; then
    tailnetServeStarted=1
    notePresent "$label" "remote port $resolvedRemotePort"
    return 0
  fi
  if ! glissaServeRouteIsOursToReplace "$backends"; then
    noteWarned "$label" \
      "port $glissaServeHttpsPort proxies a backend this topic has no record of publishing, leaving it up"
    return 0
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    noteWarned "$label" "timeout not on PATH, run: tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  if ! publishGlissaServeRoute "$resolvedRemotePort"; then
    noteWarned "$label" "run: tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  recordGlissaServeOwnership "$resolvedRemotePort"
  if [[ "$(glissaServeOwnedPort)" != "$resolvedRemotePort" ]]; then
    markDotfilesStatePending "$glissaServeWithdrawalStateName"
    if ! tailscale serve --https="$glissaServeHttpsPort" off >/dev/null 2>&1; then
      noteWarned "$label" \
        "published route is live because its ownership record and withdrawal failed, run: tailscale serve --https=$glissaServeHttpsPort off"
      return 0
    fi
    clearDotfilesState "$glissaServeWithdrawalStateName"
    noteWarned "$label" "published route was withdrawn because its ownership record could not be written"
    return 0
  fi
  tailnetServeStarted=1
  noteApplied "$label" "remote port $resolvedRemotePort"
}

noteGlissaServeUnreadableConfig() {
  local label="$1"
  if glissaServeWithdrawalIsPending; then
    noteWarned "$label" \
      "cannot read $glissaConfigDisplayPath and a withdrawal is still owed, run: tailscale serve --https=$glissaServeHttpsPort off"
    return 0
  fi
  noteWarned "$label" "cannot read $glissaConfigDisplayPath, leaving the route as it is"
}

# One state machine: what the config says, then what the tailnet says, then publish, withdraw, or leave it alone.
configureGlissaServe() {
  local label="Tailscale serve"
  local remoteState
  if ! command -v tailscale >/dev/null 2>&1; then
    noteWarned "$label" "tailscale not on PATH"
    return 0
  fi
  if [[ ! -f "$glissaConfigPath" ]]; then
    noteWarned "$label" "no $glissaConfigDisplayPath, serve skipped"
    return 0
  fi
  remoteState="$(readGlissaRemoteState)"
  if [[ "$remoteState" == "disabled" ]]; then
    withdrawGlissaServe "$label"
    return 0
  fi
  if [[ "$remoteState" == "enabled" ]]; then
    clearDotfilesState "$glissaServeWithdrawalStateName"
    publishGlissaServe "$label"
    return 0
  fi
  noteGlissaServeUnreadableConfig "$label"
}

probeGlissaRemoteTls() {
  local label="remote access"
  local publicHost
  local httpStatus
  if ((tailnetServeStarted == 0)); then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  publicHost="$(readGlissaPublicHost)"
  if ! hasDottedGlissaHost "$publicHost"; then
    return 0
  fi
  if ! httpStatus="$(probeHttpStatus "https://$publicHost/")"; then
    noteWarned "$label" \
      "TLS probe failed for https://$publicHost/: enable MagicDNS and HTTPS Certificates in the Tailscale admin console, DNS tab, then re-run"
    return 0
  fi
  if [[ "$httpStatus" =~ ^[234][0-9][0-9]$ ]]; then
    notePresent "$label" "TLS verified for https://$publicHost/ (HTTP $httpStatus)"
    return 0
  fi
  noteWarned "$label" "TLS probe returned HTTP $httpStatus for https://$publicHost/"
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
