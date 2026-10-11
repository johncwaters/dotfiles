# shellcheck shell=bash

kinesisModifierMappingKey="com.apple.keyboard.modifiermapping.7504-24926-0"
kinesisModifierMappingPath="$dotfilesRepo/peripherals/keyboard/kinesis-modifier-mapping.plist"
altTabDomain="com.lwouis.alt-tab-macos"
altTabShortcutDirectory="$dotfilesRepo/peripherals/keyboard/alt-tab"
# AltTab discards any shortcut not stored as its own archived dict, so these are captured from the app rather than written by hand.
altTabShortcutKeys=(holdShortcut)

plistBuddyCommand() {
  trustedPlatformTestPath "${DOTFILES_TEST_PLISTBUDDY:-}" || printf '/usr/libexec/PlistBuddy\n'
}

defaultsInScope() {
  local hostScope="$1"
  shift
  if [[ "$hostScope" == "currentHost" ]]; then
    defaults -currentHost "$@"
    return
  fi
  defaults "$@"
}

# plutil splits key paths on dots, and the modifier mapping key is full of them.
printLiveDefaultsValue() {
  local hostScope="$1"
  local domainName="$2"
  local valueKey="$3"
  local exportedDomainPath
  local printStatus=0
  exportedDomainPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-defaults-domain.XXXXXX")"
  if ! defaultsInScope "$hostScope" export "$domainName" "$exportedDomainPath" 2>/dev/null; then
    rm -f -- "$exportedDomainPath"
    return 1
  fi
  "$(plistBuddyCommand)" -x -c "Print :$valueKey" "$exportedDomainPath" 2>/dev/null || printStatus=$?
  rm -f -- "$exportedDomainPath"
  return "$printStatus"
}

liveDefaultsValueMatches() {
  local hostScope="$1"
  local domainName="$2"
  local valueKey="$3"
  local trackedValuePath="$4"
  local liveValue
  if ! liveValue="$(printLiveDefaultsValue "$hostScope" "$domainName" "$valueKey")"; then
    return 1
  fi
  [[ "$liveValue" == "$(<"$trackedValuePath")" ]]
}

writeTrackedDefaultsValue() {
  local hostScope="$1"
  local domainName="$2"
  local valueKey="$3"
  local trackedValuePath="$4"
  defaultsInScope "$hostScope" write "$domainName" "$valueKey" "$(<"$trackedValuePath")"
}
