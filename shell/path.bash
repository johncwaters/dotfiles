# shellcheck shell=bash
prependToPathOnce "$HOME/.local/bin"
prependToPathOnce "$DOTFILES/bin"
if isDarwin; then
  darwinApplicationsDirectory="$(applicationsDirectory)"
  darwinHomebrewPrefix="$(homebrewPrefix)"
  [[ -d "$darwinApplicationsDirectory/VSCodium.app/Contents/Resources/app/bin" ]] && \
    prependToPathOnce "$darwinApplicationsDirectory/VSCodium.app/Contents/Resources/app/bin"
  [[ -d "$darwinHomebrewPrefix/sbin" ]] && prependToPathOnce "$darwinHomebrewPrefix/sbin"
  [[ -d "$darwinHomebrewPrefix/bin" ]] && prependToPathOnce "$darwinHomebrewPrefix/bin"
  unset darwinApplicationsDirectory darwinHomebrewPrefix
fi
