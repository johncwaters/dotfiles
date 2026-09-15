#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

fontDirectory="$HOME/.local/share/fonts"
if isDarwin; then
  fontDirectory="$HOME/Library/Fonts"
fi
fontFiles=(
  "CommitMono-400-Italic.otf"
  "CommitMono-400-Regular.otf"
  "CommitMono-700-Italic.otf"
  "CommitMono-700-Regular.otf"
)
fontsChanged=0
fontCacheStateName="fonts-cache-refresh-pending"

for fontFile in "${fontFiles[@]}"; do
  fontDestination="$fontDirectory/$fontFile"
  fontLinkOutcome=""
  linkEntry "${fontFile%.otf}" "fonts/$fontFile" "$fontDestination" fontLinkOutcome
  if [[ "$fontLinkOutcome" == "changed" ]]; then
    fontsChanged=1
  fi
done

if isDarwin; then
  clearDotfilesState "$fontCacheStateName"
  finishTopic
fi

# A cache the last run could not rebuild is still owed, whatever this run changed.
if ((fontsChanged == 0)) && ! dotfilesStateIsPending "$fontCacheStateName"; then
  finishTopic
fi

markDotfilesStatePending "$fontCacheStateName"

if ! command -v fc-cache >/dev/null 2>&1; then
  noteWarned "font cache" "fc-cache missing, install fontconfig"
  finishTopic
fi

if ! fc-cache -f >/dev/null; then
  noteWarned "font cache" "fc-cache failed"
  finishTopic
fi

clearDotfilesState "$fontCacheStateName"

finishTopic
