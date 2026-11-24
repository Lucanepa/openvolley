// The OpenVolley logo for the app's own screens: the SVGs in brand/ (see
// brand/README.md), so they stay crisp at any size and pixel density. Vite
// bundles them (the small mark inlined), so they also load offline.
import mark from '../brand/mark.svg'
import lockup from '../brand/lockup.svg'
import lockupStacked from '../brand/lockup-stacked.svg'
// Rasters of the same SVGs (scripts/make-brand-assets.py) for the serve indicators
// and the scoresheet / its PDF, whose capture draws rasters reliably. Imported, so
// each build gets a content-hashed URL: an update never shows a cached old ball.
import ballPng from './ball_fallback.png'
import lockupPng from './assets/brand/openvolley_lockup.png'

export const BRAND = {
  /** The ball alone, square. */
  mark,
  /** Ball + "OpenVolley" in one line (width ~4.6x the height). */
  lockup,
  /** Ball above "OpenVolley" (about 4:3), for square-ish slots. */
  lockupStacked,
  /** The ball (brand/ball.svg, the small-size cut on a white disc), 256 px PNG. */
  ballPng,
  /** The one-line lockup as a PNG (1024 px wide). */
  lockupPng
}
