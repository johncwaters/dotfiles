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

shellsFilePath() {
  trustedPlatformTestPath "${DOTFILES_TEST_SHELLS_FILE:-}" || printf '/etc/shells\n'
}

# sudo -n, so an unattended converge fails into a warning instead of a password prompt no carbon unit will answer.
# Only root may terminate the shells file, so the newline an unterminated last line needs rides in front of the appended path.
# sudo reads the password from /dev/tty, so the retry is gated on that and on stderr, never on stdin, which curl | bash hands to the pipe.
registerAcceptedLoginShell() {
  local loginShellPath="$1"
  local shellsFile="$2"
  local appendedText="$loginShellPath"
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  if [[ -s "$shellsFile" ]] && [[ -n "$(tail -c 1 -- "$shellsFile" 2>/dev/null)" ]]; then
    appendedText=$'\n'"$loginShellPath"
  fi
  if printf '%s\n' "$appendedText" | sudo -n /usr/bin/tee -a "$shellsFile" >/dev/null; then
    return 0
  fi
  if [[ ! -t 2 ]] || ! { : < /dev/tty; } 2>/dev/null; then
    return 1
  fi
  printf '%s\n' "$appendedText" | sudo /usr/bin/tee -a "$shellsFile" >/dev/null
}

# $SHELL is the shell that launched this run, not the shell the account logs in with, so a converged machine would rerun chsh forever.
accountLoginShell() {
  local recordedLoginShell=""
  if isDarwin; then
    recordedLoginShell="$(darwinAccountRecord UserShell || true)"
  fi
  if [[ -n "$recordedLoginShell" ]]; then
    printf '%s\n' "$recordedLoginShell"
    return 0
  fi
  printf '%s\n' "${SHELL:-}"
}

ensureDarwinLoginShell() {
  if ! isDarwin; then
    return 0
  fi
  local homebrewBash
  local shellsFile
  homebrewBash="$(homebrewPrefix)/bin/bash"
  shellsFile="$(shellsFilePath)"
  if ! grep -qxF "$homebrewBash" "$shellsFile" 2>/dev/null; then
    if ! registerAcceptedLoginShell "$homebrewBash" "$shellsFile"; then
      noteWarned "login shell" "could not add $homebrewBash to $shellsFile"
    fi
  fi
  if [[ "$(accountLoginShell)" == "$homebrewBash" ]]; then
    notePresent "login shell" "$homebrewBash"
    return 0
  fi
  if ! chsh -s "$homebrewBash"; then
    noteWarned "login shell" "chsh refused $homebrewBash"
    return 0
  fi
  noteApplied "login shell" "changed to $homebrewBash"
}

ensureDarwinLoginShell

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
  clearDestinationIfNotPlainFile "topics" "$topicsFile" || return 0
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
