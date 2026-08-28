#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

stubLineFor() {
  printf '[[ -f "$HOME/.dotfiles/shell/%s" ]] && source "$HOME/.dotfiles/shell/%s"' "$1" "$1"
}

installShellStub() {
  local label="$1"
  local stubLine
  stubLine="$(stubLineFor "${label#.}")"
  ensureStubFile "$label" "$HOME/$label" "$stubLine" <<< "$stubLine"
  if [[ -n "$lastBackupPath" ]]; then
    displacedBackupNames+=("$(basename -- "$lastBackupPath")")
  fi
}

displacedBackupNames=()
installShellStub ".bashrc"
installShellStub ".bash_profile"

renderTopicList() {
  local topicsFile="$HOME/.config/dotfiles/topics"
  local wanted
  wanted="$(readProfileTopics "$(profileDirectory "$profileName")/profile.json")" || {
    noteWarned "topics" "could not read the $profileName topic list"
    return 0
  }
  local usableTopicNames=()
  local topicName
  while IFS= read -r topicName; do
    if topicIsKnown "$topicName"; then
      usableTopicNames+=("$topicName")
      continue
    fi
    if [[ -n "$topicName" ]]; then
      noteWarned "topics" "dropped \"$topicName\" from the $profileName list; no such topic in this repo"
    fi
  done <<< "$wanted"
  local rendered=""
  if ((${#usableTopicNames[@]} > 0)); then
    rendered="$(printf '%s\n' "${usableTopicNames[@]}")"
  fi
  if [[ -f "$topicsFile" && ! -L "$topicsFile" ]] && [[ "$(cat -- "$topicsFile")" == "$rendered" ]]; then
    notePresent "topics" "rendered"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$topicsFile")"
  clearDestinationForRender "topics" "$topicsFile" || return 0
  printf '%s\n' "$rendered" > "$topicsFile"
  noteApplied "topics" "rendered for $profileName"
}

if [[ -n "${profileName:-}" ]]; then
  renderTopicList
fi

noteLocalrcState() {
  if ((${#displacedBackupNames[@]} > 0)); then
    local backupList
    backupList="$(printf '%s, ' "${displacedBackupNames[@]}")"
    noteWarned ".localrc" \
      "move the machine env out of the ${backupList%, } backups into ~/.localrc (shape: shell/localrc.example)"
    return 0
  fi
  if [[ -f "$HOME/.localrc" ]]; then
    return 0
  fi
  noteDetail ".localrc" "absent; machine only env belongs in ~/.localrc (shape: shell/localrc.example)"
}

noteLocalrcState

finishTopic
