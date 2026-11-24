# Lucanepa/homebrew-tap

This file is the README of the tap repository: copy it to the root of
`github.com/Lucanepa/homebrew-tap` once. The casks themselves are written
there by `escoresheet/deploy/homebrew/bump-cask.sh` (in the openvolley repo).

Homebrew casks of the OpenVolley desktop apps for macOS 11 or newer (Apple
silicon and Intel, one universal app):

```bash
brew install --cask lucanepa/tap/openvolley   # OpenVolley eScoresheet
brew install --cask lucanepa/tap/openbeach    # OpenBeach
```

OpenVolley eScoresheet and OpenBeach are signed and notarized by Apple: they
open like any other app, offline too.

The apps update themselves (signed updates, installed when you quit, never
during a match); `brew upgrade` only follows. More: https://get.openvolley.app
