# shellcheck shell=bash
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/profile.sh"

reposProfileListPath() {
  local dotfilesRepo
  local activeProfile
  dotfilesRepo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  activeProfile="${profileName:-$(resolveProfileName || true)}"
  [[ -n "$activeProfile" ]] || return 1
  requireSafeName profile "$activeProfile" || return 1
  local profileListPath="$dotfilesRepo/profiles/$activeProfile/repos.txt"
  [[ -f "$profileListPath" ]] || return 1
  printf '%s\n' "$profileListPath"
}

reposListPath() {
  if [[ -n "${DOTFILES_REPOS_FILE:-}" ]]; then
    printf '%s\n' "$DOTFILES_REPOS_FILE"
    return 0
  fi
  if reposProfileListPath; then
    return 0
  fi
  local topicDirectory
  topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "$topicDirectory/repos.txt"
}

reposListIsProfileDeclared() {
  local profilesDirectory
  local resolvedListPath
  profilesDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../profiles" && pwd -P)"
  resolvedListPath="$(realpath -- "$1" 2>/dev/null)" || return 1
  [[ "$resolvedListPath" == "$profilesDirectory/"*/repos.txt ]]
}

pathIsRepositoryRoot() {
  local resolvedPath
  local resolvedTopLevel
  local topLevel
  topLevel="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  resolvedPath="$(realpath -- "$1" 2>/dev/null)" || return 1
  resolvedTopLevel="$(realpath -- "$topLevel" 2>/dev/null)" || return 1
  [[ "$resolvedPath" == "$resolvedTopLevel" ]]
}

normalizeListLine() {
  local listLine="${1#$'\xef\xbb\xbf'}"
  printf '%s\n' "${listLine%$'\r'}"
}

listLineIsAnEntry() {
  if [[ "$1" =~ ^[[:space:]]*# ]]; then
    return 1
  fi
  [[ "$1" == *=* ]]
}

normalizeListPath() {
  local listPath="${1//\\//}"
  listPath="${listPath#"${listPath%%[![:space:]]*}"}"
  printf '%s\n' "${listPath%"${listPath##*[![:space:]]}"}"
}

# Fields are whitespace separated, so a tab is as good as a space and "path = url" leaves no empty field behind.
entryFieldsOf() {
  local entryFields=()
  read -r -a entryFields <<< "${1#*=}"
  if ((${#entryFields[@]} == 0)); then
    return 0
  fi
  printf '%s\n' "${entryFields[@]}"
}
