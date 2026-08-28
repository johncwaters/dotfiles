#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

gitIdentityPath="$HOME/.gitconfig.local"
identitySource="the environment"

liveGitSetting() {
  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi
  git config --global --get "$1" 2>/dev/null || true
}

# Read before the link displaces ~/.gitconfig: it holds the only copy of the identity.
gitUserName="${GIT_USER_NAME:-}"
gitUserEmail="${GIT_USER_EMAIL:-}"
if [[ -z "$gitUserName" ]]; then
  gitUserName="$(liveGitSetting user.name)"
  identitySource="the config already on this machine"
fi
if [[ -z "$gitUserEmail" ]]; then
  gitUserEmail="$(liveGitSetting user.email)"
  identitySource="the config already on this machine"
fi

# Not git config: it exits non-zero for reasons unrelated to the file, and reading that as "no identity here" appends a duplicate every run. A [user "subsection"] names a signing identity, not this file's own.
localIdentityDeclares() {
  local settingKey="${1#user.}"
  awk -v wantedKey="$settingKey" '
    BEGIN { inUserSection = 0; declared = 0 }
    {
      line = $0
      sub(/[;#].*$/, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line ~ /^\[/) {
        headerEnd = index(line, "]")
        if (headerEnd == 0) next
        header = tolower(substr(line, 1, headerEnd))
        inUserSection = (header == "[user]")
        line = substr(line, headerEnd + 1)
        gsub(/^[ \t]+|[ \t]+$/, "", line)
      }
      if (line == "" || inUserSection == 0) next
      if (tolower(line) ~ ("^" wantedKey "[ \t]*=")) declared = 1
    }
    END { exit(declared == 1 ? 0 : 1) }
  ' "$gitIdentityPath"
}

# The link has already displaced the config the captured value came from, so this is its last copy.
fillMissingIdentityField() {
  local settingKey="$1"
  local capturedValue="$2"
  local environmentVariable="$3"
  if localIdentityDeclares "$settingKey"; then
    return 0
  fi
  if [[ -z "$capturedValue" ]]; then
    noteWarned "git identity" "$gitIdentityPath declares no $settingKey, set it or export $environmentVariable"
    return 0
  fi
  terminateFinalLine "$gitIdentityPath"
  printf '[user]\n\t%s = %s\n' "${settingKey#user.}" "$capturedValue" >> "$gitIdentityPath"
  noteApplied "git identity" "$settingKey filled in from $identitySource"
}

linkEntry "gitconfig" "git/.gitconfig" "$HOME/.gitconfig"

# -f follows a symlink, so appending through one would write an identity into a file nobody here chose.
if [[ -L "$gitIdentityPath" ]]; then
  noteWarned "git identity" "local config is a symlink, move it aside: $gitIdentityPath"
  finishTopic
fi

if [[ -f "$gitIdentityPath" ]]; then
  if localIdentityDeclares user.name && localIdentityDeclares user.email; then
    notePresent "git identity" "local config present"
    finishTopic
  fi
  fillMissingIdentityField user.name "$gitUserName" GIT_USER_NAME
  fillMissingIdentityField user.email "$gitUserEmail" GIT_USER_EMAIL
  finishTopic
fi

if [[ -e "$gitIdentityPath" || -L "$gitIdentityPath" ]]; then
  noteWarned "git identity" "local config is not a regular file: $gitIdentityPath"
  finishTopic
fi

if [[ -n "$gitUserName" && -n "$gitUserEmail" ]]; then
  umask 077
  printf '[user]\n\tname = %s\n\temail = %s\n' "$gitUserName" "$gitUserEmail" > "$gitIdentityPath"
  noteApplied "git identity" "carried over from $identitySource"
  finishTopic
fi

noteWarned "git identity" "missing $gitIdentityPath, copy git/.gitconfig.local.example or set GIT_USER_NAME and GIT_USER_EMAIL"
finishTopic
