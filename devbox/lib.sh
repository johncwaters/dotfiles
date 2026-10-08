devboxTopicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
devboxGlimmervoidVersion="0.29.1"

resolveDevboxWorkspace() {
  devboxSkipReason=""
  devboxCoderPath="$HOME/.local/bin/coder"
  if [[ ! -x "$devboxCoderPath" ]]; then
    devboxSkipReason="Coder CLI absent"
    return 1
  fi
  local identityJson
  if ! identityJson="$("$devboxCoderPath" whoami --output json 2>/dev/null)"; then
    devboxSkipReason="Coder not logged in; run coder login https://coder.dev.posthog.dev"
    return 1
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
  devboxDashboardUrl="https://3457--dev--$devboxWorkspaceName--$coderUsername.coder.dev.posthog.dev/"
}

pushDevboxScript() {
  local remoteArguments=("$devboxGlimmervoidVersion" "${1:-provision}")
  if [[ "${1:-}" == pair ]]; then
    local pairingLabel="${2:-}"
    local apostropheReplacement="'\"'\"'"
    pairingLabel="${pairingLabel//\'/$apostropheReplacement}"
    remoteArguments+=("'$pairingLabel'")
  fi
  CODER_SSH_DISABLE_AUTOSTART=true "$devboxCoderPath" ssh "$devboxWorkspaceName" -- bash -s -- \
    "${remoteArguments[@]}" < "$devboxTopicDirectory/provision.sh"
}

runDevboxCommand() {
  local subcommand="${1:-status}"
  if (($# > 0)); then shift; fi
  case "$subcommand" in
    up | status)
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
    *) printf 'Usage: devbox {up|pair [label]|restart-glimmervoid [--yes]|status}\n' >&2; return 1 ;;
  esac
  if ! resolveDevboxWorkspace; then
    printf 'devbox: %s\n' "${devboxSkipReason:-workspace lookup failed}" >&2
    return 1
  fi
  case "$subcommand" in
    up)
      case "$devboxWorkspaceStatus" in
        stopped) "$devboxCoderPath" start "$devboxWorkspaceName" --yes || return ;;
        running | starting) ;;
        *) printf 'devbox: workspace is %s; cannot provision\n' "$devboxWorkspaceStatus" >&2; return 1 ;;
      esac
      pushDevboxScript
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
