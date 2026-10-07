// The OpenVolley logo for the app's own screens: the SVGs in brand/ (see
// brand/README.md), so they stay crisp at any size and pixel density. Vite
// bundles them (the small mark inlined), so they also load offline.
import mark from '../brand/mark.svg'
import lockup from '../brand/lockup.svg'
import lockupStacked from '../brand/lockup-stacked.svg'

export const BRAND = {
  /** The ball alone, square. */
  mark,
  /** Ball + "OpenVolley" in one line (width ~4.6x the height). */
  lockup,
  /** Ball above "OpenVolley" (about 4:3), for square-ish slots. */
  lockupStacked
}
