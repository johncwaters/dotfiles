# shellcheck shell=bash
prependToPathOnce "$HOME/.local/bin"
prependToPathOnce "$DOTFILES/bin"
if [[ -x "$HOME/.dotnet/dotnet" ]]; then
  prependToPathOnce "$HOME/.dotnet"
  export DOTNET_ROOT="$HOME/.dotnet"
fi
