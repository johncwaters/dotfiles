#!/usr/bin/env bash
set -euo pipefail

docsPageUrls=(
  "https://posthog.com/docs/libraries/next-js.md"
  "https://posthog.com/docs/libraries/js/config.md"
  "https://posthog.com/docs/advanced/proxy/nextjs.md"
  "https://posthog.com/llms.txt"
)
llmsIndexUrl="https://posthog.com/llms.txt"
snapshotTime="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
snapshotDirectory="${XDG_CACHE_HOME:-$HOME/.cache}/gauge-reader/docs-snapshots"
snapshotPath="${1:-$snapshotDirectory/$snapshotTime.json}"

pageEntries="[]"
for pageUrl in "${docsPageUrls[@]}"; do
  pageSha256="$(curl -fsSL "$pageUrl" | sha256sum | cut -d' ' -f1)"
  pageEntries="$(jq --arg url "$pageUrl" --arg sha256 "$pageSha256" '. + [{url: $url, sha256: $sha256}]' <<< "$pageEntries")"
done

llmsIndexLastModified="$(curl -fsSI "$llmsIndexUrl" | tr -d '\r' | awk -F': ' 'tolower($1) == "last-modified" { print $2 }')"

mkdir -p "$(dirname "$snapshotPath")"
jq -n --arg takenAt "$snapshotTime" --argjson pages "$pageEntries" \
  --arg llmsIndexUrl "$llmsIndexUrl" --arg llmsIndexLastModified "$llmsIndexLastModified" \
  '{takenAt: $takenAt, pages: $pages, llmsIndex: {url: $llmsIndexUrl, lastModified: $llmsIndexLastModified}}' > "$snapshotPath"
echo "$snapshotPath"
