# shellcheck shell=bash
systemdUserDirectory="$HOME/.config/systemd/user"
glimmervoidUnitName="glimmervoid"
glimmervoidLaunchAgentLabel="dev.dotfiles.glimmervoid"
glimmervoidUnitPath="$systemdUserDirectory/$glimmervoidUnitName.service"
glimmervoidSlicePath="$systemdUserDirectory/app-glimmervoid.slice"
glimmervoidServiceInputsStateName="glimmervoid-service-inputs-record"

# Splicing the ambient PATH in makes the unit differ between converging shells, and every difference restarts the live service.
glimmervoidUnitSearchPath() {
  local nodeDirectory="$1"
  local candidateDirectory
  local searchPath=""
  for candidateDirectory in "$HOME/.glimmervoid/bin" "$HOME/.npm-global/bin" "$HOME/.local/bin" "$nodeDirectory" \
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

renderGlimmervoidUnit() {
  local templatePath="$1"
  local destinationPath="$2"
  local nodePath="$3"
  local unitPath
  local nodeDirectory
  nodeDirectory="$(dirname -- "$nodePath")"
  unitPath="$(glimmervoidUnitSearchPath "$nodeDirectory")"
  sed \
    -e "s/__PATH__/$(sedReplacementFor "$unitPath")/g" \
    "$templatePath" > "$destinationPath"
}

enableGlimmervoidLinger() {
  local label="glimmervoid linger"
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

readGlimmervoidBootOnlySettings() {
  local nodePath
  local renderedSettings
  if [[ ! -f "$glimmervoidConfigPath" ]]; then
    printf 'absent\n'
    return 0
  fi
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    printf 'unreadable\n'
    return 0
  fi
  renderedSettings="$("$nodePath" -p 'JSON.stringify((function canonical(value) { return Array.isArray(value) ? value.map(canonical) : (value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value); })({ port: (require(process.argv[1]) || {}).port, remote: (require(process.argv[1]) || {}).remote }))' "$glimmervoidConfigPath" 2>/dev/null)" || renderedSettings=""
  if [[ -z "$renderedSettings" ]]; then
    printf 'unreadable\n'
    return 0
  fi
  printf '%s\n' "$renderedSettings"
}

# The token is stored in cleartext under ~/.local/state, so the secrets file travels as a digest and never as its values.
readGlimmervoidSecretsDigest() {
  local nodePath
  local digest
  if [[ ! -f "$glimmervoidSecretsPath" ]]; then
    printf 'absent\n'
    return 0
  fi
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    printf 'unreadable\n'
    return 0
  fi
  digest="$("$nodePath" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$glimmervoidSecretsPath" 2>/dev/null)" || digest=""
  if [[ -z "$digest" ]]; then
    printf 'unreadable\n'
    return 0
  fi
  printf '%s\n' "$digest"
}

# The server hot-reloads most of config.json and rewrites it on every session event; the keys glimmervoid reads once at boot and the environment file systemd loads once at boot are what a restart is owed for.
glimmervoidServiceInputsToken() {
  printf 'boot-only %s\nsecrets %s\n' \
    "$(readGlimmervoidBootOnlySettings)" "$(readGlimmervoidSecretsDigest)"
}

glimmervoidServiceInputsChanged() {
  local inputsToken="$1"
  local recordedInputs
  if ! recordedInputs="$(readDotfilesState "$glimmervoidServiceInputsStateName")"; then
    return 0
  fi
  [[ "$recordedInputs" != "$inputsToken" ]]
}

recordGlimmervoidServiceInputs() {
  writeDotfilesState "$glimmervoidServiceInputsStateName" "$1"
}

startGlimmervoidService() {
  local unitChanged="$1"
  local label="glimmervoid service"
  local inputsToken
  if ! userServiceManagerIsReachable; then
    noteWarned "$label" "user service manager not reachable, unit installed but not started"
    return 1
  fi
  # A secrets file written while the restart runs must stay owed, so the compared token is the one recorded.
  inputsToken="$(glimmervoidServiceInputsToken)"
  if ((remoteSettingsRewritten == 1)) || glimmervoidServiceInputsChanged "$inputsToken"; then
    unitChanged=1
  fi
  if ! enableUserService "$label" "$glimmervoidUnitName" "$unitChanged"; then
    return 1
  fi
  recordGlimmervoidServiceInputs "$inputsToken"
}

installGlimmervoidSlice() {
  local sliceChanged=0
  if ! filesAreIdentical "$dotfilesRepo/glimmervoid/app-glimmervoid.slice" "$glimmervoidSlicePath"; then
    sliceChanged=1
  fi
  copyEntry "glimmervoid slice" "glimmervoid/app-glimmervoid.slice" "$glimmervoidSlicePath"
  ((sliceChanged == 1))
}

# systemd applies a slice's limits live on reload, so a slice-only change owes no restart of the sessions it holds.
reloadUserManagerForGlimmervoidSlice() {
  if ! userServiceManagerIsReachable; then
    return 0
  fi
  if ! systemctl --user daemon-reload >/dev/null 2>&1; then
    noteWarned "glimmervoid slice" "run: systemctl --user daemon-reload"
  fi
}

installGlimmervoidService() {
  local label="glimmervoid service"
  local templatePath="$dotfilesRepo/glimmervoid/glimmervoid.service"
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
  if ! nodePath="$(resolveGlimmervoidNodePath)"; then
    noteWarned "$label" "no node in ~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /usr/bin or /bin"
    return 0
  fi
  mkdir -p -- "$systemdUserDirectory"
  if ! clearDestinationIfNotPlainFile "$label" "$glimmervoidUnitPath"; then
    return 0
  fi
  stagedUnit="$(mktemp "$systemdUserDirectory/.glimmervoid.service.XXXXXX")"
  renderGlimmervoidUnit "$templatePath" "$stagedUnit" "$nodePath"
  if commitRenderedFile "$label" "$stagedUnit" "$glimmervoidUnitPath"; then
    unitChanged=1
    noteApplied "$label" "installed"
  fi
  if ((unitChanged == 0)); then
    notePresent "$label" "up to date"
  fi
  if installGlimmervoidSlice && ((unitChanged == 0)); then
    reloadUserManagerForGlimmervoidSlice
  fi
  if ! startGlimmervoidService "$unitChanged"; then
    return 0
  fi
  probeGlimmervoidServiceHealthUnlessRestartIsOwed
  enableGlimmervoidLinger
}

probeGlimmervoidHttp() {
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
  noteWarned "$label" "no HTTP $expectedStatus from $url, run: journalctl --user -u glimmervoid -n 20"
}

probeGlimmervoidServiceHealth() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if ! resolveGlimmervoidLocalPort; then
    return 0
  fi
  probeGlimmervoidHttp "glimmervoid health" "http://127.0.0.1:$resolvedLocalPort/" "200" "local listener serving"
  if ! isGlimmervoidRemoteEnabled; then
    return 0
  fi
  if ! resolveGlimmervoidPorts; then
    return 0
  fi
  probeGlimmervoidHttp "glimmervoid remote health" "http://127.0.0.1:$resolvedRemotePort/" "401" "remote listener auth-gated"
}

# The old process keeps the ports the config held before this run edited them, so probing the edited ports now polls a listener nobody answers on and blames a healthy service.
probeGlimmervoidServiceHealthUnlessRestartIsOwed() {
  if userServiceActivationIsPending "glimmervoid"; then
    notePresent "glimmervoid health" "probe waits on the owed glimmervoid restart"
    return 0
  fi
  probeGlimmervoidServiceHealth
}
