# shellcheck shell=bash

colorReset=$'\033[0m'
colorCyan=$'\033[36m'
colorGreen=$'\033[32m'
colorYellow=$'\033[33m'
colorRed=$'\033[31m'
colorDarkGray=$'\033[90m'

if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then
  colorReset=""
  colorCyan=""
  colorGreen=""
  colorYellow=""
  colorRed=""
  colorDarkGray=""
fi

countsFilePath=""
warningsEmittedHere=0

useCountsFile() {
  countsFilePath="$1"
}

refuseCountsFile() {
  printf 'dotfiles: ignoring $DOTFILES_COUNTS_FILE %s (%s); this process counts on its own.\n' \
    "$1" "$2" >&2
}

# Bootstrap seeds its counts file with a nonce, so a path named by anyone else is ignored.
adoptCountsFileFromEnvironment() {
  local candidatePath="${DOTFILES_COUNTS_FILE:-}"
  local expectedNonce="${DOTFILES_COUNTS_NONCE:-}"
  if [[ -z "$candidatePath" ]]; then
    return 0
  fi
  if [[ -z "$expectedNonce" ]]; then
    refuseCountsFile "$candidatePath" "no \$DOTFILES_COUNTS_NONCE to match it against"
    return 0
  fi
  if [[ -L "$candidatePath" || ! -f "$candidatePath" ]]; then
    refuseCountsFile "$candidatePath" "not a regular file"
    return 0
  fi
  if [[ "$(head -n 1 -- "$candidatePath")" != "nonce $expectedNonce" ]]; then
    refuseCountsFile "$candidatePath" "nonce does not match"
    return 0
  fi
  useCountsFile "$candidatePath"
}

# The counts file can be lost mid run, so a topic's exit status carries its own warnings.
finishTopic() {
  if ((warningsEmittedHere > 0)); then
    exit 1
  fi
  exit 0
}

appendCountToken() {
  if [[ -z "$countsFilePath" ]]; then
    return 0
  fi
  printf '%s\n' "$1" >> "$countsFilePath"
}

writeSection() {
  local title="$1"
  printf '\n'
  printf '%s  %s%s\n' "$colorCyan" "$title" "$colorReset"
}

writeLine() {
  local mark="$1"
  local color="$2"
  local label="$3"
  local note="$4"
  printf '    %s[%s]%s %-30s %s%s%s\n' "$color" "$mark" "$colorReset" "$label" "$colorDarkGray" "$note" "$colorReset"
}

noteApplied() {
  writeLine " ok " "$colorGreen" "$1" "$2"
  appendCountToken applied
}

noteInstalled() {
  writeLine " ++ " "$colorYellow" "$1" "$2"
  appendCountToken installed
}

notePresent() {
  writeLine " -- " "$colorDarkGray" "$1" "$2"
  appendCountToken present
}

noteWarned() {
  writeLine "warn" "$colorRed" "$1" "$2"
  warningsEmittedHere=$((warningsEmittedHere + 1))
  appendCountToken warned
}

noteDetail() {
  writeLine " -- " "$colorDarkGray" "$1" "$2"
}

writeSummary() {
  local elapsedSeconds="$1"
  local appliedCount="$2"
  local installedCount="$3"
  local presentCount="$4"
  local warnedCount="$5"
  printf '\n'
  printf '%s  Done in %ss: %s changed, %s installed, %s already current, %s warnings.%s\n' \
    "$colorCyan" "$elapsedSeconds" "$appliedCount" "$installedCount" "$presentCount" "$warnedCount" "$colorReset"
}
