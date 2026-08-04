// Sport registry — the ONE place the three sports differ. The control API, SourceManager and
// LedboxClient are all sport-agnostic: every sport speaks the same a/b liveState contract and the
// same action verbs (point/set/timeout/sub/serve/swap/team/next-set/…), just with sport-specific
// meaning (basketball: point=+1/+2/+3, sub=team foul, set=period, next-set=end quarter). So a
// sport is fully described by three things: its scoring Source, its board layout names, and the
// state→sections mapper for the match screen. Everything else (idle/crest/countdown/break) reuses
// the proven volleyball path, so switching sport can't destabilise the idle screens.
//
// Volleyball is the default and the shape the other rows mirror. To add a sport: add a row here
// and its key to settings.js SPORTS.

import { ManualSource } from './manualSource.js'
import { BeachSource } from './beachSource.js'
import { BasketballSource } from './basketballSource.js'
import * as volley from './volleyballMapper.js'
import { toBeachSections } from './beachMapper.js'
import { toBasketballSections } from './basketballMapper.js'

// The full mapper surface LedboxClient paints through. Beach and basketball differ from volleyball
// ONLY in the match screen (toSections); idle / crest / countdown / break are identical, so they
// reuse these volleyball mappers verbatim (paired with the volleyball idle/crest layouts below).
const volleyMapper = {
  toSections: volley.toSections,
  toCountdownSections: volley.toCountdownSections,
  toIdleSections: volley.toIdleSections,
  toClubIdleSections: volley.toClubIdleSections,
  toBreakSections: volley.toBreakSections,
  toLeftRight: volley.toLeftRight,
}

// Idle + crest are sport-neutral (crest + team names), so every sport uses the hardware-proven
// volleyball idle screens. Only the match layout is sport-specific.
const IDLE_LAYOUTS = { idleLayout: 'kscw_idle', crestLayout: 'kscw_crest', clockLayout: 'kscw_clock' }

export const SPORTS = {
  volleyball: {
    key: 'volleyball',
    label: 'Volleyball',
    Source: ManualSource,
    layouts: { layout: 'volleyball_matchscore_02', ...IDLE_LAYOUTS },
    mapper: volleyMapper,
  },
  beach: {
    key: 'beach',
    label: 'Beach volleyball',
    Source: BeachSource,
    layouts: { layout: 'beach_matchscore', ...IDLE_LAYOUTS },
    mapper: { ...volleyMapper, toSections: toBeachSections },
  },
  basketball: {
    key: 'basketball',
    label: 'Basketball',
    Source: BasketballSource,
    layouts: { layout: 'basketball_matchscore', ...IDLE_LAYOUTS },
    mapper: { ...volleyMapper, toSections: toBasketballSections },
  },
}

export const DEFAULT_SPORT = 'volleyball'
export const SPORT_KEYS = Object.keys(SPORTS)
// [{ key, label }] for the control UI's sport picker.
export const SPORT_LIST = SPORT_KEYS.map((k) => ({ key: k, label: SPORTS[k].label }))

// Never return undefined — an unknown/absent key falls back to the default so a bad setting
// can never leave the appliance without a source at boot.
export function getSport(key) {
  return SPORTS[key] || SPORTS[DEFAULT_SPORT]
}
