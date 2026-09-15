# shellcheck shell=bash
prependToPathOnce "$HOME/.local/bin"
prependToPathOnce "$DOTFILES/bin"
if isDarwin; then
  darwinCodiumBinDirectory="$(codiumBundleBinDirectory)"
  darwinHomebrewPrefix="$(homebrewPrefix)"
  [[ -d "$darwinCodiumBinDirectory" ]] && prependToPathOnce "$darwinCodiumBinDirectory"
  [[ -d "$darwinHomebrewPrefix/sbin" ]] && prependToPathOnce "$darwinHomebrewPrefix/sbin"
  [[ -d "$darwinHomebrewPrefix/bin" ]] && prependToPathOnce "$darwinHomebrewPrefix/bin"
  unset darwinCodiumBinDirectory darwinHomebrewPrefix
fi
