# shellcheck shell=bash

set -euo pipefail

libDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dotfilesRepo="$(cd -- "$libDirectory/../.." && pwd)"
dotfilesAlias="$HOME/.dotfiles"
backupSuffix=".pre-dotfiles.bak"

# shellcheck source=./platform.sh
source "$libDirectory/platform.sh"
# shellcheck source=./log.sh
source "$libDirectory/log.sh"
# shellcheck source=./state.sh
source "$libDirectory/state.sh"
# shellcheck source=./link.sh
source "$libDirectory/link.sh"
# shellcheck source=./render.sh
source "$libDirectory/render.sh"
# shellcheck source=./profile.sh
source "$libDirectory/profile.sh"

profileName="${profileName:-$(resolveProfileName || true)}"
if [[ -n "$profileName" ]] && ! requireSafeName "profile" "$profileName"; then
  exit 1
fi

adoptCountsFileFromEnvironment

aliasResolvesToRepo() {
  [[ -L "$dotfilesAlias" ]] || return 1
  local resolved
  resolved="$(cd -- "$dotfilesAlias" 2>/dev/null && pwd -P)" || return 1
  [[ "$resolved" == "$(cd -- "$dotfilesRepo" && pwd -P)" ]]
}

requireAliasResolvesToRepo() {
  if aliasResolvesToRepo; then
    return 0
  fi
  printf 'dotfiles: %s does not point at %s; run script/bootstrap first.\n' \
    "$dotfilesAlias" "$dotfilesRepo" >&2
  exit 1
}
