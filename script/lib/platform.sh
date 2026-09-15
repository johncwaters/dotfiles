# shellcheck shell=bash

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

trustedPlatformTestPath() {
  local configuredPath="$1"
  local sandboxMarker="$HOME/.dotfiles-test-sandbox"
  if [[ -z "$configuredPath" ]]; then
    return 1
  fi
  if [[ -L "$sandboxMarker" || ! -f "$sandboxMarker" || ! -O "$sandboxMarker" || ! -O "$HOME" ]]; then
    return 1
  fi
  printf '%s\n' "$configuredPath"
}

homebrewPrefix() {
  trustedPlatformTestPath "${DOTFILES_TEST_HOMEBREW_PREFIX:-}" || printf '/opt/homebrew\n'
}

applicationsDirectory() {
  trustedPlatformTestPath "${DOTFILES_TEST_APPLICATIONS_DIRECTORY:-}" || printf '/Applications\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  platformName
fi
