# shellcheck shell=bash

# The committing skill reads the marker, so a test run points it at a sandbox rather than repointing the machine it runs on.
profileMarkerPath() {
  printf '%s\n' "${DOTFILES_MARKER_PATH:-$dotfilesRepo/.machine-profile}"
}

# The marker is a caller-supplied write target that gets truncated, so a path holding anything but a profile name is refused rather than destroyed.
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

# Reads the "topics" array without a JSON parser so bootstrap can run before the packages topic has installed node.
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

readProfilePlatform() {
  local profileJsonPath="$1"
  if [[ ! -f "$profileJsonPath" ]]; then
    return 2
  fi
  local profileText
  profileText="$(tr -d '\n' < "$profileJsonPath")"
  if [[ ! "$profileText" =~ \"platform\"[[:space:]]*:[[:space:]]* ]]; then
    return 1
  fi
  local rawPlatform
  rawPlatform="$(sed -n 's/.*"platform"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' \
    <<< "$profileText" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$rawPlatform" == *'{'* || "$rawPlatform" == *'['* || "$rawPlatform" == *':'* ]]; then
    printf '%s\n' "$rawPlatform"
    return 2
  fi
  if [[ "$rawPlatform" =~ ^\"([^\"]*)\"$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  printf '%s\n' "$rawPlatform"
  return 2
}

# Bootstrap can run before node is installed, so the fallback accepts only a flat object of string or boolean pairs.
settingsFileIsWellFormed() {
  local settingsPath="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$settingsPath" \
      >/dev/null 2>&1
    return $?
  fi
  local settingsText
  settingsText="$(tr '\n' ' ' < "$settingsPath")"
  local settingPair='"[^"\\]*"[[:space:]]*:[[:space:]]*("[^"\\]*"|true|false)'
  [[ "$settingsText" =~ ^[[:space:]]*\{[[:space:]]*($settingPair[[:space:]]*(,[[:space:]]*$settingPair[[:space:]]*)*)?\}[[:space:]]*$ ]]
}

# Status 2 separates an unparseable file from an absent one: guessing between them prunes what a machine's owner wanted kept.
readProfileSetting() {
  local settingsPath="$1"
  local settingKey="$2"
  if [[ ! -f "$settingsPath" ]]; then
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const settingKey = process.argv[2];
      if (!Object.prototype.hasOwnProperty.call(settings, settingKey)) process.exit(2);
      const settingValue = settings[settingKey];
      if (typeof settingValue !== "string" && typeof settingValue !== "boolean") process.exit(2);
      process.stdout.write(String(settingValue));
    ' "$settingsPath" "$settingKey" 2>/dev/null || return 2
    printf '\n'
    return 0
  fi
  if ! settingsFileIsWellFormed "$settingsPath"; then
    return 2
  fi
  local rawSettingValue
  rawSettingValue="$(tr -d '\n' < "$settingsPath" \
    | sed -n "s/.*\"$settingKey\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\\1/p" \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$rawSettingValue" == \"*\" ]]; then
    printf '%s\n' "${rawSettingValue:1:${#rawSettingValue}-2}"
    return 0
  fi
  if [[ "$rawSettingValue" == "true" || "$rawSettingValue" == "false" ]]; then
    printf '%s\n' "$rawSettingValue"
    return 0
  fi
  if [[ -z "$rawSettingValue" ]]; then
    return 2
  fi
  return 2
}

# Every entry point resolves a profile the same way: the marker and the name are caller supplied, so both are checked before a topic list is read.
resolveProfileTopics() {
  local toolName="$1"
  local wantedProfile="$2"
  local profileJsonPath
  local topicsOutput
  requireSafeName "profile" "$wantedProfile" || return 1
  requireUsableMarkerPath || return 1
  profileJsonPath="$(profileDirectory "$wantedProfile")/profile.json"
  if [[ ! -f "$profileJsonPath" ]]; then
    printf '%s: no such profile %s (expected %s).\n' "$toolName" "$wantedProfile" \
      "$profileJsonPath" >&2
    return 1
  fi
  if ! topicsOutput="$(readProfileTopics "$profileJsonPath")"; then
    printf '%s: could not read the topics list in %s.\n' "$toolName" "$profileJsonPath" >&2
    return 1
  fi
  if [[ -z "$topicsOutput" ]]; then
    return 0
  fi
  printf '%s\n' "$topicsOutput"
}

topicIsKnown() {
  nameIsSafe "$1" || return 1
  [[ -d "$dotfilesRepo/$1" && -f "$dotfilesRepo/$1/install.sh" ]]
}
