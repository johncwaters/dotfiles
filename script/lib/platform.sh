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

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  platformName
fi
