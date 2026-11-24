# OpenBeach logo (B2 "sun") for the desktop app

Copies of openbeach's `escoresheet/frontend/brand/icon-tile.svg` and
`favicon.svg` (the openbeach repo's `brand/README.md` describes the logo:
OpenVolley's ball on a dune `#efd8ae` tile). They are the sources of
OpenBeach's desktop app icons, `src-tauri/icons/beach/` (listed in
`tauri.beach.conf.json`):

    cd escoresheet/frontend && python3 scripts/make-beach-icons.py

`icon-tile.svg` gives 48 px and up, `favicon.svg` (the small-size cut, the
ball near the tile's edge) 16 to 32 px. Commit the SVGs and the renders
together.
