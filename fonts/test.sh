#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "fonts"

fontCacheBinDirectory="$stubBin"
fontCacheLog="$sandbox/fc-cache.log"
mkdir -p "$fontCacheBinDirectory" "$sandbox/.local/share/fonts"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >> "$FONT_CACHE_LOG"' \
  > "$fontCacheBinDirectory/fc-cache"
chmod +x "$fontCacheBinDirectory/fc-cache"

foreignFontPath="$sandbox/.local/share/fonts/CommitMono-400-Regular.otf"
printf 'foreign font\n' > "$foreignFontPath"

runInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 PATH="$fontCacheBinDirectory:$PATH" \
    FONT_CACHE_LOG="$fontCacheLog" bash "$topicDir/install.sh"
}

fontLinksThroughTheAlias() {
  local fontPath="$1"
  [[ -L "$fontPath" ]] || return 1
  [[ "$(readlink -- "$fontPath")" == "$sandbox/.dotfiles"/* ]] || return 1
  [[ -e "$fontPath" ]]
}

fontFiles=(
  "CommitMono-400-Italic.otf"
  "CommitMono-400-Regular.otf"
  "CommitMono-700-Italic.otf"
  "CommitMono-700-Regular.otf"
)

printf '\nfonts topic\n'

firstRunStatus=0
firstRunOutput="$(runInstall)" || firstRunStatus=$?
check "install exits clean" test "$firstRunStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
check "fc-cache runs after the first install" test -f "$fontCacheLog"
check "fc-cache refreshes the cache" grep -qx -- '-f' "$fontCacheLog"

for fontFile in "${fontFiles[@]}"; do
  check "$fontFile linked through the alias" \
    fontLinksThroughTheAlias "$sandbox/.local/share/fonts/$fontFile"
done

foreignFontBackup="$foreignFontPath.pre-dotfiles.bak"
check "a foreign font is backed up" test -f "$foreignFontBackup"
check "the backup keeps the foreign font" grep -qx 'foreign font' "$foreignFontBackup"

secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "second install exits clean" test "$secondRunStatus" -eq 0
check "second run reports no changes" reportsNoChanges "$secondRunOutput"
check "fc-cache does not run on the second install" test "$(wc -l < "$fontCacheLog")" -eq 1

fontCacheMissingBinDirectory="$sandbox/no-fc-cache-bin"
mkdir -p "$fontCacheMissingBinDirectory"
for requiredCommand in dirname mkdir mv ln readlink rm; do
  ln -s "$(command -v "$requiredCommand")" "$fontCacheMissingBinDirectory/$requiredCommand"
done

runInstallWithoutFontCache() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 PATH="$fontCacheMissingBinDirectory" \
    "$BASH" "$topicDir/install.sh"
}

rm -f "$sandbox/.local/share/fonts/CommitMono-700-Regular.otf"
missingFontCacheStatus=0
missingFontCacheOutput="$(runInstallWithoutFontCache)" || missingFontCacheStatus=$?
check "a missing fc-cache warns rather than passing quietly" test "$missingFontCacheStatus" -eq 1
check "a missing fc-cache is reported" \
  outputMatches "$missingFontCacheOutput" '\[warn\].*fc-cache missing'
check "a missing fc-cache still links the fonts" \
  fontLinksThroughTheAlias "$sandbox/.local/share/fonts/CommitMono-700-Regular.otf"
fontCachePendingState="$sandbox/.local/state/dotfiles/fonts-cache-refresh-pending"
check "what a missing fc-cache still owes is recorded under the shared state directory" \
  test -f "$fontCachePendingState"

: > "$fontCacheLog"
retriedCacheStatus=0
retriedCacheOutput="$(runInstall)" || retriedCacheStatus=$?
check "the run after a missing fc-cache refreshes the cache even though no link changed" \
  grep -qx -- '-f' "$fontCacheLog"
check "the retried refresh exits clean" test "$retriedCacheStatus" -eq 0
check "the retried refresh is reported as no change to the links" \
  reportsNoChanges "$retriedCacheOutput"
check "the retried refresh clears what was owed" test ! -e "$fontCachePendingState"

: > "$fontCacheLog"
settledCacheOutput="$(runInstall)" || true
check "the run after a settled refresh leaves fc-cache alone" test ! -s "$fontCacheLog"
check "the run after a settled refresh reports no change" reportsNoChanges "$settledCacheOutput"

startStubbedSandbox "fonts-darwin"
linkCoreUtilities bash dirname mkdir mv ln readlink rm
darwinPendingState="$sandbox/.local/state/dotfiles/fonts-cache-refresh-pending"
mkdir -p "$(dirname -- "$darwinPendingState")"
: > "$darwinPendingState"

runDarwinInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM=darwin DOTFILES_PROFILE=work NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

darwinStatus=0
darwinOutput="$(runDarwinInstall)" || darwinStatus=$?
check "darwin installs fonts without fontconfig" test "$darwinStatus" -eq 0
for fontFile in "${fontFiles[@]}"; do
  check "darwin links $fontFile for CoreText" \
    fontLinksThroughTheAlias "$sandbox/Library/Fonts/$fontFile"
done
check "darwin does not populate the Linux font directory" test ! -d "$sandbox/.local/share/fonts"
check "darwin clears stale font-cache debt" test ! -e "$darwinPendingState"
check "darwin does not warn about fc-cache" outputLacks "$darwinOutput" 'fc-cache'
checkRerunIsQuiet "a darwin rerun reports no changes" "$(runDarwinInstall)"

reportTopicResults "fonts"
