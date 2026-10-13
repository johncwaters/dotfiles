#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

gitconfigPath="$HOME/.gitconfig"
localGitconfigPath="$HOME/.gitconfig.local"
xdgGitconfigPath="${XDG_CONFIG_HOME:-$HOME/.config}/git/config"

gitconfigStubMarker='# Shared settings come from ~/.config/git/config, linked by dotfiles.'
retiredGitconfigStubMarker=$'\tpath = ~/.dotfiles/git/gitconfig'

# git reads the XDG config only while ~/.gitconfig is absent, so the seed follows that order.
previousGitconfigPath() {
  local candidate
  for candidate in "$gitconfigPath" "$xdgGitconfigPath"; do
    [[ -f "$candidate" ]] || continue
    destinationIsOurs "$candidate" "$gitconfigStubMarker" && continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

escapedForSed() {
  printf '%s' "$1" | sed -e 's#[][\.^$*+?(){}|/]#\\&#g'
}

# git resolves a relative include against the including file, so any of these would have the
# seed or the repo config include itself once the stub includes both.
withoutSelfIncludes() {
  local escapedHome escapedAlias escapedRepo
  escapedHome="$(escapedForSed "$HOME")"
  escapedAlias="$(escapedForSed "$dotfilesAlias")"
  escapedRepo="$(escapedForSed "$dotfilesRepo")"
  local pathKey='^[[:space:]]*[Pp][Aa][Tt][Hh][[:space:]]*=[[:space:]]*"?'
  local lineEnd='"?[[:space:]]*([;#].*)?$'
  sed -E \
    -e "/$pathKey(~|\\\$HOME)\\/\\.gitconfig\\.local$lineEnd/d" \
    -e "/$pathKey(\\.\\/)?\\.gitconfig\\.local$lineEnd/d" \
    -e "/$pathKey$escapedHome\\/\\.gitconfig\\.local$lineEnd/d" \
    -e "/$pathKey(~|\\\$HOME)\\/\\.dotfiles\\/git\\/gitconfig$lineEnd/d" \
    -e "/$pathKey$escapedAlias\\/git\\/gitconfig$lineEnd/d" \
    -e "/$pathKey$escapedRepo\\/git\\/gitconfig$lineEnd/d" \
    -- "$1"
}

# git resolves a relative include against the including file, and the seed lives in $HOME.
withIncludesRebasedFrom() {
  local sourceDir="$1"
  if [[ "$sourceDir" == "$HOME" ]]; then
    cat
    return
  fi
  local escapedSourceDir
  escapedSourceDir="$(escapedForSed "$sourceDir")"
  sed -E -e "s#^([[:space:]]*[Pp][Aa][Tt][Hh][[:space:]]*=[[:space:]]*)\"?([^~/\$\"[:space:]][^\"]*)\"?#\1$escapedSourceDir/\2#"
}

# git reads the XDG config and ~/.gitconfig both, so a seeded copy left in place applies twice.
retireSeedSourceIfXdg() {
  if [[ "$1" == "$gitconfigPath" ]]; then
    return 0
  fi
  moveExistingAside ".config/git/config" "$1"
}

seedLocalGitconfigFromPrevious() {
  local previousPath
  previousPath="$(previousGitconfigPath)" || return 0
  if [[ -e "$localGitconfigPath" || -L "$localGitconfigPath" ]]; then
    # A local file that exists already is never merged into, so what the displaced config held
    # only reaches the owner through the warning.
    noteWarned ".gitconfig.local" "exists, so ${previousPath/#$HOME/\~} was not merged; its backup keeps what it held"
    return 0
  fi
  local seedInProgress
  seedInProgress="$(umask 077 && mktemp "$HOME/.gitconfig.local.XXXXXX")"
  if ! withoutSelfIncludes "$previousPath" | withIncludesRebasedFrom "$(dirname -- "$previousPath")" > "$seedInProgress"; then
    rm -f -- "$seedInProgress"
    noteWarned ".gitconfig.local" "could not read $previousPath; write it by hand"
    return 0
  fi
  mv -- "$seedInProgress" "$localGitconfigPath"
  chmod 600 "$localGitconfigPath"
  noteApplied ".gitconfig.local" "seeded from the previous ${previousPath/#$HOME/\~}"
  retireSeedSourceIfXdg "$previousPath"
}

# Sandboxes that allow reading ~/.gitconfig deny an include outside it, which broke PostHog's dev-sandbox uv sync.
migrateRetiredGitconfigStub() {
  fileHoldsLine "$gitconfigPath" "$retiredGitconfigStubMarker" || return 0
  local keptLines
  keptLines="$(grep -vxF -- "$retiredGitconfigStubMarker" "$gitconfigPath" || true)"
  printf '%s\n%s\n' "$gitconfigStubMarker" "$keptLines" > "$gitconfigPath"
  noteApplied ".gitconfig" "shared include moved to ${xdgGitconfigPath/#$HOME/\~}"
}

migrateRetiredGitconfigStub
seedLocalGitconfigFromPrevious
ensureStubFile ".gitconfig" "$gitconfigPath" "$gitconfigStubMarker" <<STUB
$gitconfigStubMarker
[include]
	path = ~/.gitconfig.local
STUB
linkEntry "git config" "git/gitconfig" "$xdgGitconfigPath"
if [[ -n "$lastBackupPath" ]]; then
  noteWarned "git config" "the previous one no longer applies; merge ${lastBackupPath/#$HOME/\~} into ~/.gitconfig.local"
fi

if [[ ! -f "$localGitconfigPath" ]]; then
  noteWarned ".gitconfig.local" "missing; copy git/gitconfig.local.example there and fill it in"
fi

finishTopic
