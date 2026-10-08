devboxTopicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
devboxGlimmervoidVersion="0.30.0"
devboxLookupUnauthenticated=3
source "$devboxTopicDirectory/../script/lib/profile.sh"

readDevboxProfile() {
  local dotfilesRepo="$(cd -- "$devboxTopicDirectory/.." && pwd)"
  local activeProfile="${profileName:-$(resolveProfileName || true)}"
  [[ -n "$activeProfile" ]] || return 1
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
  local identityJson
  if ! identityJson="$("$devboxCoderPath" whoami --output json 2>/dev/null)"; then
    devboxSkipReason="coder whoami failed; run coder login ${devboxDeploymentUrl}"
    return "$devboxLookupUnauthenticated"
  fi
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
  if ! devboxWorkspaceStatus="$(printf '%s' "$workspacesJson" | node -e '
    const workspaces = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(workspaces)) process.exit(1);
    const workspace = workspaces.find((workspace) => workspace.name === process.argv[1] && (!workspace.owner_name || workspace.owner_name === process.argv[2]));
    if (workspace) console.log(workspace.latest_build.status);
  ' "$devboxWorkspaceName" "$coderUsername")"; then
    printf 'devbox: cannot read Coder workspace status\n' >&2
    return 2
  fi
  if [[ -z "$devboxWorkspaceStatus" ]]; then
    devboxSkipReason="no workspace named $devboxWorkspaceName"
    return 1
  fi
  devboxDashboardUrl="https://3457--dev--$devboxWorkspaceName--$coderUsername.${devboxWorkspaceDomain}/"
}

runDevboxSsh() {
  CODER_SSH_DISABLE_AUTOSTART=true CODER_SSH_USAGE_APP=disable "$devboxCoderPath" ssh "$devboxWorkspaceName" -- "$@"
}

pushDevboxScript() {
  local remoteArguments=("$devboxGlimmervoidVersion" "${1:-provision}")
  if [[ "${1:-}" == pair ]]; then
    local pairingLabel="${2:-}"
    local apostropheReplacement="'\"'\"'"
    pairingLabel="${pairingLabel//\'/$apostropheReplacement}"
    remoteArguments+=("'$pairingLabel'")
  fi
  runDevboxSsh bash -s -- \
    "${remoteArguments[@]}" < "$devboxProfileDirectory/devbox/provision.sh"
}

pushDevboxSnapshot() (
  set -o pipefail
  local snapshotRepo="${dotfilesRepo:-$(cd -- "$devboxTopicDirectory/.." && pwd)}"
  local snapshotCommit remoteCommit
  if ! snapshotCommit="$(git -C "$snapshotRepo" rev-parse HEAD)"; then
    printf '[warned] dotfiles: cannot read committed HEAD\n'
    return 1
  fi
  if ! remoteCommit="$(pushDevboxScript snapshot-status)"; then
    printf '[warned] dotfiles: cannot read remote snapshot commit\n'
    return 1
  fi
  if [[ "$remoteCommit" == "$snapshotCommit" ]]; then
    printf '[present] dotfiles: %s\n' "$snapshotCommit"
    return 0
  fi
  local remoteScript apostropheReplacement="'\"'\"'"
  remoteScript="$(cat "$devboxProfileDirectory/devbox/provision.sh")"
  remoteScript="${remoteScript//\'/$apostropheReplacement}"
  if git -C "$snapshotRepo" archive --format=tar "$snapshotCommit" \
    | runDevboxSsh bash -c "'$remoteScript'" -- "$devboxGlimmervoidVersion" snapshot "$snapshotCommit"; then
    return 0
  fi
  printf '[warned] dotfiles: snapshot or bootstrap failed\n'
  return 1
)

provisionDevbox() {
  pushDevboxScript prepare || return
  pushDevboxSnapshot || true
  pushDevboxScript provision
}

runDevboxCommand() {
  local subcommand="${1:-status}"
  if (($# > 0)); then shift; fi
  case "$subcommand" in
    up | status | ensure)
      if (($# > 0)); then
        printf 'Usage: devbox %s\n' "$subcommand" >&2
        return 1
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
    *) printf 'Usage: devbox {up|pair [label]|restart-glimmervoid [--yes]|status|ensure}\n' >&2; return 1 ;;
  esac
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
      if [[ "$devboxWorkspaceStatus" != running ]]; then
        return 0
      fi
      provisionDevbox
      return
      ;;
    up)
      case "$devboxWorkspaceStatus" in
        stopped) "$devboxCoderPath" start "$devboxWorkspaceName" --yes || return ;;
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
    pair) pushDevboxScript pair "${1:-$(hostname)}" ;;
    restart-glimmervoid) pushDevboxScript restart ;;
  esac
}
