# shellcheck shell=bash
# Sourced by the bootstrap prelude as well as every topic, so it stays bash 3.2 clean.

platformName() {
  local detectedPlatform="${DOTFILES_PLATFORM:-}"
  if [[ -z "$detectedPlatform" ]]; then
    case "$(uname -s)" in
      Darwin) detectedPlatform="darwin" ;;
      Linux) detectedPlatform="linux" ;;
    esac
  fi
  case "$detectedPlatform" in
    darwin | linux)
      printf '%s\n' "$detectedPlatform"
      return 0
      ;;
  esac
  printf 'dotfiles: unsupported platform %s\n' "${detectedPlatform:-unknown}" >&2
  return 1
}

isDarwin() {
  [[ "$(platformName)" == "darwin" ]]
}

sandboxMarkerIsThisAccountsOwn() {
  local sandboxMarker="$HOME/.dotfiles-test-sandbox"
  if [[ -L "$sandboxMarker" || ! -f "$sandboxMarker" || ! -O "$sandboxMarker" ]]; then
    return 1
  fi
  [[ -O "$HOME" ]]
}

# /usr/bin/dscl is SIP protected, so on a mac only it may answer the home lookup the stub seam's trust rests on.
darwinDirectoryServiceCommand() {
  local attributeName="${1:-}"
  local stubDirectoryService="${DOTFILES_TEST_STUB_BIN:-}/dscl"
  if [[ -x /usr/bin/dscl && "$attributeName" != NFSHomeDirectory && -x "$stubDirectoryService" ]] &&
    trustedPlatformTestPath "${DOTFILES_TEST_STUB_BIN:-}" >/dev/null; then
    printf '%s\n' "$stubDirectoryService"
    return 0
  fi
  if [[ -x /usr/bin/dscl ]]; then
    printf '/usr/bin/dscl\n'
    return 0
  fi
  if [[ -z "${DOTFILES_TEST_STUB_BIN:-}" || ! -x "$stubDirectoryService" ]]; then
    return 1
  fi
  if ! sandboxMarkerIsThisAccountsOwn; then
    return 1
  fi
  printf '%s\n' "$stubDirectoryService"
}

withoutLeadingSpace() {
  printf '%s\n' "${1#"${1%%[![:space:]]*}"}"
}

# dscl wraps a value holding a space onto an indented line of its own, so the attribute line alone is not the answer.
darwinAccountRecord() {
  local attributeName="$1"
  local accountName
  local directoryServiceCommand
  local recordLine
  local recordValue=""
  local valueIsOnTheNextLine=0
  accountName="$(/usr/bin/id -un 2>/dev/null || true)"
  if [[ -z "$accountName" ]]; then
    return 1
  fi
  directoryServiceCommand="$(darwinDirectoryServiceCommand "$attributeName")" || return 1
  while IFS= read -r recordLine; do
    if ((valueIsOnTheNextLine == 1)); then
      recordValue="$(withoutLeadingSpace "$recordLine")"
      break
    fi
    if [[ "$recordLine" != "$attributeName:"* ]]; then
      continue
    fi
    recordValue="$(withoutLeadingSpace "${recordLine#"$attributeName:"}")"
    if [[ -n "$recordValue" ]]; then
      break
    fi
    valueIsOnTheNextLine=1
  done < <("$directoryServiceCommand" . -read "/Users/$accountName" "$attributeName" 2>/dev/null)
  if [[ -z "$recordValue" ]]; then
    return 1
  fi
  printf '%s\n' "$recordValue"
}

accountPasswdHome() {
  local passwdFields=()
  local darwinHome
  if isDarwin || [[ ! -x /usr/bin/getent && -x /usr/bin/dscl ]]; then
    darwinHome="$(darwinAccountRecord NFSHomeDirectory)" || return 1
    printf '%s\n' "$darwinHome"
    return 0
  fi
  if [[ ! -x /usr/bin/getent ]]; then
    return 1
  fi
  IFS=: read -r -a passwdFields < <(/usr/bin/getent passwd "$EUID" 2>/dev/null)
  printf '%s\n' "${passwdFields[5]:-}"
}

# The harness always runs out of a directory it made, so a marker in the account's own home is somebody planting one.
homeIsTheAccountsOwnHome() {
  local passwdHome
  if ! passwdHome="$(accountPasswdHome)"; then
    return 0
  fi
  if [[ -z "$passwdHome" ]]; then
    return 0
  fi
  [[ "$passwdHome" == "$HOME" ]]
}

# An environment variable alone must never redirect what runs as root, so every override opens only inside a home the harness marked and this account does not live in.
trustedPlatformTestPath() {
  local configuredPath="$1"
  if [[ -z "$configuredPath" ]]; then
    return 1
  fi
  if ! sandboxMarkerIsThisAccountsOwn; then
    return 1
  fi
  if homeIsTheAccountsOwnHome; then
    return 1
  fi
  printf '%s\n' "$configuredPath"
}

firstHomebrewPrefixHoldingBrew() {
  local candidatePrefix
  for candidatePrefix in "$@"; do
    if [[ -x "$candidatePrefix/bin/brew" ]]; then
      printf '%s\n' "$candidatePrefix"
      return 0
    fi
  done
  printf '%s\n' "$1"
}

# An Intel mac keeps Homebrew at /usr/local, and a plist or chsh naming a prefix the machine lacks never runs.
homebrewPrefix() {
  local configuredPrefix
  configuredPrefix="$(trustedPlatformTestPath "${DOTFILES_TEST_HOMEBREW_PREFIX:-}" || true)"
  if [[ -n "$configuredPrefix" ]]; then
    printf '%s\n' "$configuredPrefix"
    return 0
  fi
  firstHomebrewPrefixHoldingBrew /opt/homebrew /usr/local
}

applicationsDirectory() {
  trustedPlatformTestPath "${DOTFILES_TEST_APPLICATIONS_DIRECTORY:-}" || printf '/Applications\n'
}

codiumBundleBinDirectory() {
  printf '%s/VSCodium.app/Contents/Resources/app/bin\n' "$(applicationsDirectory)"
}

tailscaleBundleCliPath() {
  printf '%s/Tailscale.app/Contents/MacOS/Tailscale\n' "$(applicationsDirectory)"
}

ghosttyBundleCliPath() {
  printf '%s/Ghostty.app/Contents/MacOS/ghostty\n' "$(applicationsDirectory)"
}
