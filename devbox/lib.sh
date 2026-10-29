devboxTopicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dotfilesCheckout="${dotfilesRepo:-$(cd -- "$devboxTopicDirectory/.." && pwd)}"
devboxLookupUnauthenticated=3
devboxFallbackReleaseStatus=75
devboxFailedBuildRetryDelaySeconds=1800
source "$devboxTopicDirectory/../script/lib/profile.sh"

readDevboxProfile() {
  local dotfilesRepo="$dotfilesCheckout"
  local activeProfile="${profileName:-$(resolveProfileName || true)}"
  [[ -n "$activeProfile" ]] || return 1
  devboxProfileName="$activeProfile"
  devboxProfileDirectory="$devboxTopicDirectory/../profiles/$activeProfile"
  [[ -f "$devboxProfileDirectory/devbox/provision.sh" ]] || return 1
  devboxDeploymentUrl="$(readProfileSetting "$devboxProfileDirectory/coder.json" deploymentUrl)" || return 1
  devboxWorkspaceDomain="$(readProfileSetting "$devboxProfileDirectory/coder.json" workspaceDomain)" || return 1
}

resolveDevboxWorkspace() {
  devboxSkipReason=""
  if ! readDevboxProfile; then
    devboxSkipReason="no profile deployment configured"
    return 1
  fi
  devboxCoderPath="$HOME/.local/bin/coder"
  if [[ ! -x "$devboxCoderPath" ]]; then
    devboxSkipReason="Coder CLI absent"
    return 1
  fi
  local identityJson whoamiErrorPath whoamiError
  if ! whoamiErrorPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-coder-whoami.XXXXXX")"; then
    printf 'devbox: cannot create a temporary file for coder whoami\n' >&2
    return 2
  fi
  if ! identityJson="$("$devboxCoderPath" whoami --output json 2>"$whoamiErrorPath")"; then
    whoamiError="$(tr -s '\n' ' ' < "$whoamiErrorPath")"
    rm -f -- "$whoamiErrorPath"
    devboxSkipReason="coder whoami failed; run coder login ${devboxDeploymentUrl}; coder said: ${whoamiError:-nothing}"
    return "$devboxLookupUnauthenticated"
  fi
  rm -f -- "$whoamiErrorPath"
  if ! command -v node >/dev/null 2>&1; then
    printf 'devbox: node is required to read Coder workspace metadata\n' >&2
    return 2
  fi
  local coderUsername
  if ! coderUsername="$(printf '%s' "$identityJson" | node -e '
    const parsedIdentity = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const identity = Array.isArray(parsedIdentity) ? parsedIdentity[0] : parsedIdentity;
    if (!identity) process.exit(1);
    if (typeof identity.username !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(identity.username)) process.exit(1);
    console.log(identity.username);
  ')"; then
    printf 'devbox: cannot read Coder username\n' >&2
    return 2
  fi
  devboxWorkspaceName="devbox-$coderUsername"
  local workspacesJson
  if ! workspacesJson="$("$devboxCoderPath" list --output json)"; then
    printf 'devbox: cannot list Coder workspaces\n' >&2
    return 2
  fi
  local workspaceBuildSummary
  if ! workspaceBuildSummary="$(printf '%s' "$workspacesJson" | node -e '
    const workspaces = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(workspaces)) process.exit(1);
    const workspace = workspaces.find((workspace) => workspace.name === process.argv[1] && (!workspace.owner_name || workspace.owner_name === process.argv[2]));
    if (!workspace) process.exit(0);
    const buildCompletedAt = Date.parse(workspace.latest_build.job?.completed_at ?? "");
    const buildAgeSeconds = Number.isNaN(buildCompletedAt) ? -1 : Math.floor((Date.now() - buildCompletedAt) / 1000);
    console.log(workspace.latest_build.status, workspace.latest_build.transition ?? "unknown", buildAgeSeconds, workspace.outdated === true ? 1 : 0);
  ' "$devboxWorkspaceName" "$coderUsername")"; then
    printf 'devbox: cannot read Coder workspace status\n' >&2
    return 2
  fi
  read -r devboxWorkspaceStatus devboxLatestBuildTransition devboxLatestBuildAgeSeconds devboxWorkspaceIsOutdated <<< "$workspaceBuildSummary"
  if [[ -z "$devboxWorkspaceStatus" ]]; then
    devboxSkipReason="no workspace named $devboxWorkspaceName"
    return 1
  fi
  devboxDashboardUrl="https://3457--dev--$devboxWorkspaceName--$coderUsername.${devboxWorkspaceDomain}/"
}

# A hung coder ssh holds an agent connection, and Coder bumps the deadline on any connection, so the box never autostops.
# coder ssh prints its outdated-template banner on every call when stderr is a TTY (coder cli/ssh.go), so stderr goes through a pipe.
runDevboxSsh() {
  local deadlineSeconds="${DEVBOX_SSH_DEADLINE_SECONDS:-1200}"
  CODER_SSH_DISABLE_AUTOSTART=true CODER_SSH_USAGE_APP=disable "$devboxCoderPath" ssh "$devboxWorkspaceName" -- "$@" <&0 2> >(cat >&2) &
  local sshPid=$!
  (
    sleep "$deadlineSeconds" &
    trap "kill $! 2>/dev/null; exit 0" TERM
    wait $!
    kill -9 "$sshPid"
  ) </dev/null >/dev/null 2>&1 &
  local watchdogPid=$!
  local sshStatus=0
  wait "$sshPid" 2>/dev/null || sshStatus=$?
  kill "$watchdogPid" 2>/dev/null
  wait "$watchdogPid" 2>/dev/null
  if ((sshStatus == 137)); then
    printf 'devbox: coder ssh ran past %s seconds; killed\n' "$deadlineSeconds" >&2
  fi
  return "$sshStatus"
}

# Under launchd SSH_AUTH_SOCK names Apple's agent, which never holds the Secretive signing key.
devboxSecretiveSocketPath="$HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"

devboxForwardedAgentSocket() {
  local inheritedSocket="${SSH_AUTH_SOCK:-}"
  if [[ -n "$inheritedSocket" && "$inheritedSocket" != */com.apple.launchd.*/Listeners ]]; then
    printf '%s\n' "$inheritedSocket"
    return 0
  fi
  if [[ -S "$devboxSecretiveSocketPath" ]]; then
    printf '%s\n' "$devboxSecretiveSocketPath"
    return 0
  fi
  printf '%s\n' "$inheritedSocket"
}

isDevboxForwardHour() {
  [[ "${DEVBOX_FORWARD_ANY_HOUR:-}" == 1 ]] && return 0
  local weekday hour
  read -r weekday hour < <(date '+%u %H')
  ((weekday <= 5 && 10#$hour >= 5 && 10#$hour < 19))
}

# Coder never autostarts a failed workspace and the workspace template sets no failure_ttl, so ensure retries it.
isDevboxFailedBuildRetryable() {
  [[ "$devboxWorkspaceStatus" == failed ]] || return 1
  [[ "$devboxLatestBuildTransition" != delete ]] || return 1
  ((devboxLatestBuildAgeSeconds >= devboxFailedBuildRetryDelaySeconds))
}

startDevbox() {
  "$devboxCoderPath" start "$devboxWorkspaceName" --yes || return
  provisionDevbox
}

holdDevboxAgentForward() {
  # Overnight DarkWakes reconnecting here bump Coder activity, so the devbox never autostops.
  isDevboxForwardHour || return 0
  local forwardedAgentSocket
  forwardedAgentSocket="$(devboxForwardedAgentSocket)"
  if [[ -z "$forwardedAgentSocket" ]]; then
    printf 'devbox: no ssh agent to forward\n' >&2
    return 1
  fi
  local heartbeatDeadlineSeconds="${DEVBOX_FORWARD_HEARTBEAT_DEADLINE_SECONDS:-45}"
  local heartbeat
  coproc forwardSession {
    SSH_AUTH_SOCK="$forwardedAgentSocket" CODER_SSH_DISABLE_AUTOSTART=true CODER_SSH_USAGE_APP=disable \
      exec ssh -T -o BatchMode=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "coder.$devboxWorkspaceName" \
      'while timeout 10 ssh-add -l >/dev/null 2>&1; do echo alive; sleep 15; done'
  }
  local forwardSessionPid="$forwardSession_PID"
  while IFS= read -r -t "$heartbeatDeadlineSeconds" -u "${forwardSession[0]}" heartbeat; do :; done
  # A hung forward ssh ignores SIGTERM, so only SIGKILL frees launchd to reconnect.
  kill -9 "$forwardSessionPid" 2>/dev/null
  wait "$forwardSessionPid" 2>/dev/null
  printf 'devbox: agent forward stopped answering; reconnecting\n' >&2
  return 1
}

pushDevboxScript() {
  local remoteArguments=("${1:-provision}" "$devboxWorkspaceDomain")
  if [[ "${1:-}" == pair ]]; then
    local pairingLabel="${2:-}"
    local apostropheReplacement="'\"'\"'"
    pairingLabel="${pairingLabel//\'/$apostropheReplacement}"
    remoteArguments+=("'$pairingLabel'")
  fi
  runDevboxSsh bash -s -- \
    "${remoteArguments[@]}" < "$devboxProfileDirectory/devbox/provision.sh"
}

convergeDevboxDotfiles() {
  if ! pushDevboxScript dotfiles; then
    printf '[warned] dotfiles: box converge did not finish\n'
    return 1
  fi
  pushDevboxScript sync-repos
}

provisionDevbox() {
  local prepareStatus=0
  pushDevboxScript prepare || prepareStatus=$?
  if ((prepareStatus != 0 && prepareStatus != devboxFallbackReleaseStatus)); then
    return "$prepareStatus"
  fi
  collectDevboxSettings || true
  convergeDevboxDotfiles || true
  pushDevboxScript provision || return
  return "$prepareStatus"
}

devboxCollectedSettingsPath() {
  printf '%s/dotfiles/devbox-collected-glimmervoid-settings.json\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

devboxSharedSettingsPath() {
  printf '%s/glimmervoid/settings.json\n' "$dotfilesCheckout"
}

showCollectedDevboxSettings() (
  local stagedPath reviewedCopyPath diffStatus=0
  stagedPath="$(devboxCollectedSettingsPath)"
  if [[ ! -f "$stagedPath" ]]; then
    printf 'devbox collect: no staged box changes\n'
    return 0
  fi
  reviewedCopyPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-devbox-review.XXXXXX")" || return 1
  trap 'rm -f -- "$reviewedCopyPath"' EXIT
  chmod 600 "$reviewedCopyPath"
  cp -- "$stagedPath" "$reviewedCopyPath" || return 1
  diff -u "$(devboxSharedSettingsPath)" "$reviewedCopyPath" || diffStatus=$?
  ((diffStatus <= 1)) || return 1
  node "$dotfilesCheckout/glimmervoid/sync-settings.mjs" staged-hash "$reviewedCopyPath"
)

acceptCollectedDevboxSettings() {
  node "$dotfilesCheckout/glimmervoid/sync-settings.mjs" accept "$(devboxCollectedSettingsPath)" "$(devboxSharedSettingsPath)" "${1:-}"
}

collectDevboxSettings() (
  local packetPath scriptPath
  if ! packetPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-devbox-settings.XXXXXX")" || ! scriptPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-devbox-collect.XXXXXX")"; then
    rm -f -- "${packetPath:-}"
    printf '[warned] glimmervoid settings: cannot create a collection workspace; nothing staged\n'
    return 1
  fi
  trap 'rm -f -- "$packetPath" "$scriptPath"' EXIT
  chmod 600 "$packetPath" "$scriptPath"
  printf '%s\n' "node --input-type=module <<'SETTINGS_MODULE'" > "$scriptPath"
  cat "$dotfilesCheckout/glimmervoid/sync-settings.mjs" >> "$scriptPath"
  printf 'const trackedProjectPaths = %s;\n' "$(node -e 'const fs=require("node:fs");console.log(JSON.stringify((JSON.parse(fs.readFileSync(process.argv[1],"utf8")).projects ?? []).map(project=>project.path)))' "$(devboxSharedSettingsPath)")" >> "$scriptPath"
  cat >> "$scriptPath" <<'REMOTE'
const home = process.env.HOME;
const live = settingsFrom(readJson(`${home}/.glimmervoid/config.json`));
const base = settingsFrom(readJson(`${home}/.glimmervoid/dotfiles-settings-base.json`));
const projectPaths = [...(live.projects ?? []).map(project => project.path), ...translateHome(trackedProjectPaths, home, 'render')].filter(projectPath => fs.existsSync(projectPath));
console.log(JSON.stringify({ home, live, base, projectPaths }));
SETTINGS_MODULE
REMOTE
  if ! runDevboxSsh bash -s -- collect-settings < "$scriptPath" > "$packetPath"; then
    printf '[warned] glimmervoid settings: cannot collect box config; nothing staged\n'
    return 1
  fi
  if ! node "$dotfilesCheckout/glimmervoid/sync-settings.mjs" collect-remote "$(devboxCollectedSettingsPath)" \
    "$(devboxSharedSettingsPath)" < "$packetPath" 2>/dev/null; then
    printf '[warned] glimmervoid settings: box config could not be merged; nothing staged\n'
    return 1
  fi
)

runDevboxCommand() {
  local subcommand="${1:-status}"
  if (($# > 0)); then shift; fi
  case "$subcommand" in
    up | status | ensure | forward-agent)
      if (($# > 0)); then
        printf 'Usage: devbox %s\n' "$subcommand" >&2
        return 1
      fi
      ;;
    collect)
      case "$#:${1:-}" in
        0: | 1:--diff | 1:--accept | 2:--accept) ;;
        *) printf 'Usage: devbox collect [--diff|--accept <hash>]\n' >&2; return 1 ;;
      esac
      if [[ -n "${1:-}" ]] && ! readDevboxProfile; then
        printf 'devbox: no profile deployment configured\n' >&2
        return 1
      fi
      if [[ "${1:-}" == --diff ]]; then
        showCollectedDevboxSettings
        return
      fi
      if [[ "${1:-}" == --accept ]]; then
        acceptCollectedDevboxSettings "${2:-}"
        return
      fi
      ;;
    pair)
      if (($# > 1)); then
        printf 'Usage: devbox pair [label]\n' >&2
        return 1
      fi
      ;;
    restart-glimmervoid)
      if (($# > 1)) || [[ -n "${1:-}" && "$1" != --yes ]]; then
        printf 'Usage: devbox restart-glimmervoid [--yes]\n' >&2
        return 1
      fi
      if [[ "${1:-}" != --yes ]]; then
        local confirmation=""
        printf 'Restart glimmervoid and end all agent sessions? [y/N] ' >&2
        if ! IFS= read -r confirmation; then
          printf '\ndevbox: restart cancelled\n' >&2
          return 1
        fi
        case "$confirmation" in
          y | Y) ;;
          *) printf 'devbox: restart cancelled\n' >&2; return 1 ;;
        esac
      fi
      ;;
    *) printf 'Usage: devbox {up|pair [label]|restart-glimmervoid [--yes]|status|ensure|forward-agent|collect [--diff|--accept <hash>]}\n' >&2; return 1 ;;
  esac
  if [[ "$subcommand" == ensure ]] && ! isDevboxForwardHour; then
    printf 'devbox ensure: skipped; outside working hours\n'
    return 0
  fi
  local lookupStatus=0
  resolveDevboxWorkspace || lookupStatus=$?
  if [[ "$subcommand" == ensure ]] && ((lookupStatus == 1)); then
    printf 'devbox ensure: skipped; %s\n' "$devboxSkipReason"
    return 0
  fi
  if [[ "$subcommand" == ensure ]] && ((lookupStatus == devboxLookupUnauthenticated)); then
    printf 'devbox ensure: %s\n' "$devboxSkipReason" >&2
    return 1
  fi
  if ((lookupStatus != 0)); then
    printf 'devbox: %s\n' "${devboxSkipReason:-workspace lookup failed}" >&2
    return 1
  fi
  case "$subcommand" in
    ensure)
      if isDevboxFailedBuildRetryable; then
        startDevbox
        return
      fi
      if [[ "$devboxWorkspaceStatus" != running ]]; then
        printf 'devbox ensure: skipped; workspace is %s\n' "$devboxWorkspaceStatus"
        return 0
      fi
      provisionDevbox
      return
      ;;
    up)
      case "$devboxWorkspaceStatus" in
        stopped | failed) startDevbox; return ;;
        running | starting) ;;
        *) printf 'devbox: workspace is %s; cannot provision\n' "$devboxWorkspaceStatus" >&2; return 1 ;;
      esac
      provisionDevbox
      return
      ;;
    status)
      printf 'workspace %s: %s\n' "$devboxWorkspaceName" "$devboxWorkspaceStatus"
      if [[ "$devboxWorkspaceStatus" != running ]]; then
        printf 'glimmervoid: not reachable\n%s\n' "$devboxDashboardUrl"
        return 0
      fi
      pushDevboxScript status
      return
      ;;
  esac
  if [[ "$devboxWorkspaceStatus" != running ]]; then
    printf 'devbox: workspace is %s; run devbox up\n' "$devboxWorkspaceStatus" >&2
    return 1
  fi
  case "$subcommand" in
    forward-agent) holdDevboxAgentForward ;;
    pair) pushDevboxScript pair "${1:-$(hostname)}" ;;
    restart-glimmervoid) pushDevboxScript restart ;;
    collect) collectDevboxSettings ;;
  esac
}
