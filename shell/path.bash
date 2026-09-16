# shellcheck shell=bash
prependToPathOnce "$HOME/.local/bin"
prependToPathOnce "$DOTFILES/bin"
if isDarwin; then
  darwinCodiumBinDirectory="$(codiumBundleBinDirectory)"
  darwinHomebrewPrefix="$(homebrewPrefix)"
  darwinPythonToolsBinDirectory="$HOME/.local/share/dotfiles/python-tools/bin"
  [[ -d "$darwinCodiumBinDirectory" ]] && prependToPathOnce "$darwinCodiumBinDirectory"
  [[ -d "$darwinHomebrewPrefix/sbin" ]] && prependToPathOnce "$darwinHomebrewPrefix/sbin"
  [[ -d "$darwinHomebrewPrefix/bin" ]] && prependToPathOnce "$darwinHomebrewPrefix/bin"
  [[ -d "$darwinPythonToolsBinDirectory" ]] && prependToPathOnce "$darwinPythonToolsBinDirectory"
  unset darwinCodiumBinDirectory darwinHomebrewPrefix darwinPythonToolsBinDirectory
fi
