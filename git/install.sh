#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

gitconfigPath="$HOME/.gitconfig"
localGitconfigPath="$HOME/.gitconfig.local"

gitconfigStubMarker=$'\tpath = ~/.dotfiles/git/gitconfig'

# git reads the XDG config only while ~/.gitconfig is absent, so the seed follows that order.
previousGitconfigPath() {
  local candidate
  for candidate in "$gitconfigPath" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config"; do
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

# A local file that exists already is never merged into, so what the displaced config held
# only reaches the owner through the warning.
warnUnmergedPrevious() {
  local previousPath="$1"
  if [[ "$previousPath" != "$gitconfigPath" ]]; then
    noteWarned ".gitconfig.local" "exists, so ${previousPath/#$HOME/\~} was not merged; it still applies beside it"
    return 0
  fi
  noteWarned ".gitconfig.local" "exists, so ~/.gitconfig was not merged; its backup keeps what it held"
}

seedLocalGitconfigFromPrevious() {
  local previousPath
  previousPath="$(previousGitconfigPath)" || return 0
  if [[ -e "$localGitconfigPath" || -L "$localGitconfigPath" ]]; then
    warnUnmergedPrevious "$previousPath"
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
  chmod 600 -- "$localGitconfigPath"
  noteApplied ".gitconfig.local" "seeded from the previous ${previousPath/#$HOME/\~}"
  retireSeedSourceIfXdg "$previousPath"
}

seedLocalGitconfigFromPrevious
ensureStubFile ".gitconfig" "$gitconfigPath" "$gitconfigStubMarker" <<STUB
[include]
$gitconfigStubMarker
	path = ~/.gitconfig.local
STUB

if [[ ! -f "$localGitconfigPath" ]]; then
  noteWarned ".gitconfig.local" "missing; copy git/gitconfig.local.example there and fill it in"
fi

finishTopic
