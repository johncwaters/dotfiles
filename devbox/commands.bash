devbox() (
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
  runDevboxCommand "$@"
)
