# shellcheck shell=bash
systemdUserDirectory="$HOME/.config/systemd/user"
glissaUnitPath="$systemdUserDirectory/glissa.service"
glissaServiceInputsStateName="glissa-service-inputs-record"

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

sedReplacementFor() {
  printf '%s' "$1" | sed -e 's|[/&\]|\\&|g'
}

renderGlissaUnit() {
  local templatePath="$1"
  local destinationPath="$2"
  local nodePath="$3"
  local unitPath
  local nodeDirectory
  nodeDirectory="$(dirname -- "$nodePath")"
  unitPath="$(glissaUnitSearchPath "$nodeDirectory")"
  sed \
    -e "s/__NODE__/$(sedReplacementFor "$nodePath")/g" \
    -e "s/__NPM__/$(sedReplacementFor "$nodeDirectory/npm")/g" \
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

readGlissaBootOnlySettings() {
  local nodePath
  local renderedSettings
  if [[ ! -f "$glissaConfigPath" ]]; then
    printf 'absent\n'
    return 0
  fi
  if ! nodePath="$(resolveGlissaNodePath)"; then
    printf 'unreadable\n'
    return 0
  fi
  renderedSettings="$("$nodePath" -p 'JSON.stringify((function canonical(value) { return Array.isArray(value) ? value.map(canonical) : (value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value); })({ port: (require(process.argv[1]) || {}).port, remote: (require(process.argv[1]) || {}).remote }))' "$glissaConfigPath" 2>/dev/null)" || renderedSettings=""
  if [[ -z "$renderedSettings" ]]; then
    printf 'unreadable\n'
    return 0
  fi
  printf '%s\n' "$renderedSettings"
}

# The server hot-reloads most of config.json and rewrites it on every session event; the app checkout and the keys glissa reads once at boot are what a restart is owed for.
glissaServiceInputsToken() {
  local checkoutToken="absent"
  if command -v git >/dev/null 2>&1; then
    checkoutToken="$(git -C "$glissaAppDirectory" rev-parse HEAD 2>/dev/null || true)"
  fi
  printf 'checkout %s\nboot-only %s\n' "$checkoutToken" "$(readGlissaBootOnlySettings)"
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
  # A pre-migration checkout builds only dist/client, so npm install there can never produce this file.
  if [[ ! -f "$glissaAppDirectory/dist/server/index.js" && ! -f "$glissaAppDirectory/server/main.ts" ]]; then
    noteWarned "$label" \
      "$glissaAppDisplayPath predates the TypeScript migration, update the checkout (git pull) before starting it"
    return 1
  fi
  if [[ ! -f "$glissaAppDirectory/dist/server/index.js" ]]; then
    noteWarned "$label" \
      "no built dist/server/index.js in $glissaAppDisplayPath, run npm install there before starting it"
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
  probeGlissaServiceHealthUnlessRestartIsOwed
  enableGlissaLinger
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

# The old process keeps the ports the config held before this run edited them, so probing the edited ports now polls a listener nobody answers on and blames a healthy service.
probeGlissaServiceHealthUnlessRestartIsOwed() {
  if userServiceActivationIsPending "glissa"; then
    notePresent "glissa health" "probe waits on the owed glissa restart"
    return 0
  fi
  probeGlissaServiceHealth
}
