#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=../script/lib/context.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"

if ! isDarwin; then
  exit 0
fi

# shellcheck source=./keyboard.sh
source "$dotfilesRepo/peripherals/keyboard.sh"

missingValues=()

collectDefaultsValue() {
  local hostScope="$1"
  local domainName="$2"
  local valueKey="$3"
  local trackedValuePath="$4"
  local liveValue
  if ! liveValue="$(printLiveDefaultsValue "$hostScope" "$domainName" "$valueKey")"; then
    missingValues+=("$domainName $valueKey")
    return 0
  fi
  mkdir -p -- "$(dirname -- "$trackedValuePath")"
  printf '%s\n' "$liveValue" > "$trackedValuePath"
}

collectDefaultsValue currentHost -g "$kinesisModifierMappingKey" "$kinesisModifierMappingPath"
for shortcutKey in "${altTabShortcutKeys[@]}"; do
  collectDefaultsValue any "$altTabDomain" "$shortcutKey" "$altTabShortcutDirectory/$shortcutKey.plist"
done

if ((${#missingValues[@]} > 0)); then
  printf 'peripherals: not set on this machine, left as tracked: %s\n' "${missingValues[*]}" >&2
  exit 0
fi
printf 'peripherals: collected the keyboard modifier swap and AltTab shortcuts\n'
