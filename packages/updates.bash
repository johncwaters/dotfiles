reportDotfilesUpgradeNotice() {
  local stateDirectory="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
  local recordPath
  for recordPath in "$stateDirectory"/upgrades-held-* "$stateDirectory"/upgrades-failed-*-pending; do
    [[ -s "$recordPath" ]] || continue
    printf '%s\n' 'dotfiles: upgrades held or failed; dot status; approve with DOTFILES_UPGRADE=all dot' >&2
    return 0
  done
}

reportDotfilesUpgradeNotice
