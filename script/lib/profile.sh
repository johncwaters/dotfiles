# shellcheck shell=bash

# The marker names the machine's live profile and the commit skill reads it, so a test
# run points it at a sandbox rather than repointing the machine it runs on.
profileMarkerPath() {
  printf '%s\n' "${DOTFILES_MARKER_PATH:-$dotfilesRepo/.machine-profile}"
}

# The marker is a caller-supplied write target that gets truncated, so a path holding
# anything but a profile name is refused rather than destroyed.
requireUsableMarkerPath() {
  local marker
  marker="$(profileMarkerPath)"
  if [[ -L "$marker" ]]; then
    printf 'dotfiles: %s is a symlink; point $DOTFILES_MARKER_PATH at a real file.\n' "$marker" >&2
    return 1
  fi
  if [[ ! -e "$marker" ]]; then
    return 0
  fi
  if [[ ! -f "$marker" ]]; then
    printf 'dotfiles: %s is not a regular file; move it aside first.\n' "$marker" >&2
    return 1
  fi
  local markedName
  markedName="$(readMarkedProfileName)"
  if [[ -z "$markedName" ]]; then
    return 0
  fi
  if ! nameIsSafe "$markedName"; then
    printf 'dotfiles: %s holds something other than a profile name; move it aside first.\n' \
      "$marker" >&2
    return 1
  fi
}

# An empty marker reads as absent, so a half written one is rewritten instead of refused.
readMarkedProfileName() {
  local marker
  marker="$(profileMarkerPath)"
  if [[ ! -f "$marker" ]]; then
    return 0
  fi
  tr -d '[:space:]' < "$marker" 2>/dev/null
}

nameIsSafe() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]]
}

requireSafeName() {
  local kind="$1"
  local name="$2"
  if nameIsSafe "$name"; then
    return 0
  fi
  printf 'dotfiles: invalid %s name "%s"; expected lowercase letters, digits and dashes.\n' \
    "$kind" "$name" >&2
  return 1
}

resolveProfileName() {
  local name="${DOTFILES_PROFILE:-}"
  if [[ -z "$name" ]]; then
    name="$(readMarkedProfileName)"
  fi
  if [[ -z "$name" ]]; then
    return 1
  fi
  requireSafeName "profile" "$name" || return 1
  printf '%s\n' "$name"
}

profileDirectory() {
  printf '%s\n' "$dotfilesRepo/profiles/$1"
}

# Reads the "topics" array without a JSON parser so bootstrap can run before the
# packages topic has installed node.
readProfileTopics() {
  local profileJsonPath="$1"
  if [[ ! -f "$profileJsonPath" ]]; then
    return 1
  fi
  local topicsRegion
  topicsRegion="$(tr -d '\n' < "$profileJsonPath" \
    | sed -n 's/.*"topics"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p')"
  if [[ "$topicsRegion" == *'{'* || "$topicsRegion" == *'['* || "$topicsRegion" == *':'* ]]; then
    printf 'dotfiles: %s has a topics array this reader cannot parse.\n' "$profileJsonPath" >&2
    return 1
  fi
  if [[ -z "${topicsRegion//[[:space:]]/}" ]]; then
    return 0
  fi
  printf '%s\n' "$topicsRegion" | grep -o '"[^"]*"' | tr -d '"'
}

topicIsKnown() {
  nameIsSafe "$1" || return 1
  [[ -d "$dotfilesRepo/$1" && -f "$dotfilesRepo/$1/install.sh" ]]
}
