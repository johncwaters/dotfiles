# shellcheck shell=bash
# install.sh and collect.sh read and write the same list, so neither one gets to decide on its own where it lives.

reposListPath() {
  local topicDirectory
  topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${DOTFILES_REPOS_FILE:-$topicDirectory/repos.txt}"
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
