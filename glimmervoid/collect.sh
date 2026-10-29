#!/usr/bin/env bash
set -euo pipefail

topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$topicDirectory/../script/lib/context.sh"
[[ "$profileName" == work ]] || exit 0
[[ -f "$HOME/.glimmervoid/config.json" ]] || exit 0
node "$topicDirectory/sync-settings.mjs" collect "$HOME/.glimmervoid/config.json" \
  "$dotfilesRepo/glimmervoid/settings.json" \
  "$HOME/.glimmervoid/dotfiles-settings-base.json" "$HOME"
