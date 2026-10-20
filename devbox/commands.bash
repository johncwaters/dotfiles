devbox() (
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
  runDevboxCommand "$@"
)

hogli() {
  local checkoutDirectory="$PWD"
  while [[ "$checkoutDirectory" != / ]]; do
    if [[ -f "$checkoutDirectory/hogli.yaml" && -x "$checkoutDirectory/bin/hogli" ]]; then
      "$checkoutDirectory/bin/hogli" "$@"
      return
    fi
    checkoutDirectory="$(dirname -- "$checkoutDirectory")"
  done
  local mainCheckout="$PROJECTS/posthog/posthog"
  HOGLI_MANIFEST="$mainCheckout/hogli.yaml" "$mainCheckout/bin/hogli" "$@"
}
