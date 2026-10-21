#!/usr/bin/env bash
set -euo pipefail

pluginRepo="PostHog/ai-plugin"
pluginRef="${1:-$(gh api "repos/$pluginRepo/commits/main" --jq .sha)}"
gaugeBinary="${GAUGE_BIN:-$HOME/.npm-global/bin/gauge}"
selfDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

skillNames="$(gh api "repos/$pluginRepo/contents/skills?ref=$pluginRef" --jq '.[] | select(.type == "dir") | .name')"

for skillName in $skillNames; do
  env -C "$selfDirectory" "$gaugeBinary" skills add "$pluginRepo#$pluginRef" --skill "$skillName" -o json \
    | jq -r '"\(.handle)@\(.label)"'
done | jq -R . | jq -s .
