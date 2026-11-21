# shellcheck shell=bash
tailnetServeStarted=0
glimmervoidServeHttpsPort=443
glimmervoidServeWithdrawalStateName="glimmervoid-serve-withdrawal-pending"
glimmervoidServeOwnedStateName="glimmervoid-serve-owned"
glimmervoidServeQueryFailed=2
glimmervoidServeQueryNodeMissing=3

# The text status gives no way to tell which https port a handler belongs to, and an exit status is the only way to tell an empty route from a question this run could not ask.
glimmervoidServeBackendsOnHttpsPort() {
  local statusJson
  local nodePath
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    return "$glimmervoidServeQueryNodeMissing"
  fi
  if ! statusJson="$(tailscale serve status --json 2>/dev/null)"; then
    return "$glimmervoidServeQueryFailed"
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
' "$glimmervoidServeHttpsPort" 2>/dev/null || return "$glimmervoidServeQueryFailed"
}

glimmervoidServeQueryFailureReason() {
  if (($1 == glimmervoidServeQueryNodeMissing)); then
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

recordGlimmervoidServeOwnership() {
  writeDotfilesState "$glimmervoidServeOwnedStateName" "$1"
}

# What this topic published is what it may withdraw; no record means no route is owned.
glimmervoidServeOwnedPort() {
  local ownedPort
  ownedPort="$(readDotfilesState "$glimmervoidServeOwnedStateName")" || ownedPort=""
  printf '%s\n' "${ownedPort%%$'\n'*}"
}

glimmervoidServeWithdrawalIsPending() {
  dotfilesStateIsPending "$glimmervoidServeWithdrawalStateName"
}

glimmervoidServeWithdrawalIsOwed() {
  if glimmervoidServeWithdrawalIsPending; then
    return 0
  fi
  isValidGlimmervoidPort "$(glimmervoidServeOwnedPort)"
}

# A tailnet this run cannot ask is not evidence of a route: with nothing recorded as published and nothing already owed, there is nothing to withdraw and nothing to warn about.
reportGlimmervoidServeUncheckedRoute() {
  local label="$1"
  local reason="$2"
  if ! glimmervoidServeWithdrawalIsOwed; then
    notePresent "$label" "skipped, glimmervoid not published on the tailnet"
    return 0
  fi
  markDotfilesStatePending "$glimmervoidServeWithdrawalStateName"
  noteWarned "$label" "$reason"
}

attemptGlimmervoidServeWithdrawal() {
  local label="$1"
  local reason="$2"
  markDotfilesStatePending "$glimmervoidServeWithdrawalStateName"
  if ! tailscale serve --https="$glimmervoidServeHttpsPort" off >/dev/null 2>&1; then
    noteWarned "$label" \
      "$reason but the route could not be withdrawn, run: tailscale serve --https=$glimmervoidServeHttpsPort off"
    return 1
  fi
  clearDotfilesState "$glimmervoidServeWithdrawalStateName"
  clearDotfilesState "$glimmervoidServeOwnedStateName"
  noteApplied "$label" "route removed, $reason"
}

# A route left up keeps every paired device's tailnet access whatever backend port it names now, so only a status this run actually parsed authorises taking one down; "serve --https=<port> off" is the CLI's own name for this.
withdrawGlimmervoidServe() {
  local label="$1"
  local backends
  local queryStatus=0
  if ! isTailscaleAuthed; then
    reportGlimmervoidServeUncheckedRoute "$label" \
      "tailscale is not authenticated, so the route on $glimmervoidServeHttpsPort cannot be checked before withdrawal; run sudo tailscale up, then tailscale serve --https=$glimmervoidServeHttpsPort off"
    return 0
  fi
  backends="$(glimmervoidServeBackendsOnHttpsPort)" || queryStatus=$?
  if ((queryStatus != 0)); then
    reportGlimmervoidServeUncheckedRoute "$label" \
      "$(glimmervoidServeQueryFailureReason "$queryStatus"), run: tailscale serve --https=$glimmervoidServeHttpsPort off"
    return 0
  fi
  if [[ -z "$backends" ]]; then
    clearDotfilesState "$glimmervoidServeWithdrawalStateName"
    clearDotfilesState "$glimmervoidServeOwnedStateName"
    notePresent "$label" "skipped, glimmervoid not published on the tailnet"
    return 0
  fi
  if ! everyBackendTargetsPort "$backends" ""; then
    noteWarned "$label" \
      "port $glimmervoidServeHttpsPort proxies something other than a local backend, leaving it up"
    return 0
  fi
  if ! glimmervoidServeRouteIsOursToReplace "$backends"; then
    noteWarned "$label" "$(glimmervoidServeNotOursReason)"
    return 0
  fi
  attemptGlimmervoidServeWithdrawal "$label" "glimmervoid not published on the tailnet" || true
}

# Without HTTPS enabled on the tailnet this asks for consent on stdin, and a converge has nobody to answer it; unbounded, it would hang the whole run instead.
publishGlimmervoidServeRoute() {
  local remotePort="$1"
  local publishStatus=0
  timeout 30 tailscale serve --bg "$remotePort" </dev/null >/dev/null 2>&1 || publishStatus=$?
  return "$publishStatus"
}

glimmervoidServeNotOursReason() {
  local ownedPort
  ownedPort="$(glimmervoidServeOwnedPort)"
  if ! isValidGlimmervoidPort "$ownedPort"; then
    printf 'port %s proxies a backend this topic has no record of publishing, leaving it up\n' \
      "$glimmervoidServeHttpsPort"
    return 0
  fi
  printf 'port %s proxies a local backend other than the port %s this topic published, leaving it up\n' \
    "$glimmervoidServeHttpsPort" "$ownedPort"
}

# An empty 443 is free to take; anything else on it may be replaced only if it is the backend this topic recorded publishing.
glimmervoidServeRouteIsOursToReplace() {
  local backends="$1"
  local ownedPort
  if [[ -z "$backends" ]]; then
    return 0
  fi
  ownedPort="$(glimmervoidServeOwnedPort)"
  if ! isValidGlimmervoidPort "$ownedPort"; then
    return 1
  fi
  everyBackendTargetsPort "$backends" "$ownedPort"
}

# Serving the local port instead of remote.port exposes the dashboard unauthenticated.
publishGlimmervoidServe() {
  local label="$1"
  local backends
  local queryStatus=0
  if ! resolveGlimmervoidPorts; then
    return 0
  fi
  if ! isTailscaleAuthed; then
    noteWarned "$label" "run sudo tailscale up once, then tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  backends="$(glimmervoidServeBackendsOnHttpsPort)" || queryStatus=$?
  if ((queryStatus != 0)); then
    noteWarned "$label" \
      "$(glimmervoidServeQueryFailureReason "$queryStatus"), leaving the route alone; run: tailscale serve status --json"
    return 0
  fi
  if everyBackendTargetsPort "$backends" "$resolvedRemotePort"; then
    clearDotfilesState "$glimmervoidServeWithdrawalStateName"
    tailnetServeStarted=1
    notePresent "$label" "remote port $resolvedRemotePort"
    return 0
  fi
  if ! glimmervoidServeRouteIsOursToReplace "$backends"; then
    noteWarned "$label" \
      "port $glimmervoidServeHttpsPort proxies a backend this topic has no record of publishing, leaving it up"
    return 0
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    noteWarned "$label" "timeout not on PATH, run: tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  # A failed serve --bg does not prove the route was not applied, so the withdrawal is owed from before the command runs until ownership is recorded.
  markDotfilesStatePending "$glimmervoidServeWithdrawalStateName"
  if ! publishGlimmervoidServeRoute "$resolvedRemotePort"; then
    noteWarned "$label" "run: tailscale serve --bg $resolvedRemotePort"
    return 0
  fi
  recordGlimmervoidServeOwnership "$resolvedRemotePort"
  if [[ "$(glimmervoidServeOwnedPort)" != "$resolvedRemotePort" ]]; then
    if ! tailscale serve --https="$glimmervoidServeHttpsPort" off >/dev/null 2>&1; then
      noteWarned "$label" \
        "published route is live because its ownership record and withdrawal failed, run: tailscale serve --https=$glimmervoidServeHttpsPort off"
      return 0
    fi
    clearDotfilesState "$glimmervoidServeWithdrawalStateName"
    noteWarned "$label" "published route was withdrawn because its ownership record could not be written"
    return 0
  fi
  clearDotfilesState "$glimmervoidServeWithdrawalStateName"
  tailnetServeStarted=1
  noteApplied "$label" "remote port $resolvedRemotePort"
}

probeGlimmervoidRemoteTls() {
  local label="remote access"
  local publicHost
  local httpStatus
  if ((tailnetServeStarted == 0)); then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  publicHost="$(readGlimmervoidPublicHost)"
  if ! hasDottedGlimmervoidHost "$publicHost"; then
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

noteGlimmervoidServeUnreadableConfig() {
  local label="$1"
  if glimmervoidServeWithdrawalIsPending; then
    noteWarned "$label" \
      "cannot read $glimmervoidConfigDisplayPath and a withdrawal is still owed, run: tailscale serve --https=$glimmervoidServeHttpsPort off"
    return 0
  fi
  noteWarned "$label" "cannot read $glimmervoidConfigDisplayPath, leaving the route as it is"
}

# The route a previous run published still names the old remote port, which the restarted service answers on as its unauthenticated local listener whenever the ports moved by one.
withdrawGlimmervoidServeStrandedByOwedRestart() {
  local label="$1"
  local backends
  local queryStatus=0
  if ! resolveGlimmervoidPorts; then
    return 0
  fi
  if ! isTailscaleAuthed; then
    return 0
  fi
  backends="$(glimmervoidServeBackendsOnHttpsPort)" || queryStatus=$?
  if ((queryStatus != 0)); then
    return 0
  fi
  if [[ -z "$backends" ]]; then
    return 0
  fi
  if everyBackendTargetsPort "$backends" "$resolvedRemotePort"; then
    return 0
  fi
  if ! glimmervoidServeRouteIsOursToReplace "$backends"; then
    return 0
  fi
  attemptGlimmervoidServeWithdrawal "$label" "the glimmervoid restart is owed" || true
}

# A run hosted by glimmervoid.service leaves the restart owed, so the old process still holds its old listeners and a route published now would proxy the tailnet at whatever those answer on.
publishGlimmervoidServeUnlessRestartIsOwed() {
  local label="$1"
  if userServiceActivationIsPending "glimmervoid"; then
    withdrawGlimmervoidServeStrandedByOwedRestart "$label"
    noteWarned "$label" \
      "the route waits on the owed glimmervoid restart, run dot from outside the service rather than systemctl --user restart glimmervoid, so the restart and the route move together"
    return 0
  fi
  publishGlimmervoidServe "$label"
}

# One state machine: what the config says, then what the tailnet says, then publish, withdraw, or leave it alone.
configureGlimmervoidServe() {
  local label="Tailscale serve"
  local remoteState
  if ! command -v tailscale >/dev/null 2>&1; then
    noteWarned "$label" "tailscale not on PATH"
    return 0
  fi
  if [[ ! -f "$glimmervoidConfigPath" ]]; then
    noteWarned "$label" "no $glimmervoidConfigDisplayPath, serve skipped"
    return 0
  fi
  remoteState="$(readGlimmervoidRemoteState)"
  if [[ "$remoteState" == "disabled" ]]; then
    withdrawGlimmervoidServe "$label"
    return 0
  fi
  if [[ "$remoteState" == "enabled" ]]; then
    publishGlimmervoidServeUnlessRestartIsOwed "$label"
    return 0
  fi
  noteGlimmervoidServeUnreadableConfig "$label"
}
