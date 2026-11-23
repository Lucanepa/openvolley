// How this device scores a rally (Options › Match options › Point entry,
// owner 22.11.2026), kept per device like the other scoring options:
//   'rallies'     Start rally at the service whistle, then Point A | Point B
//                 (the app as it always was; the default, the Point Hub board
//                 too);
//   'continuous'  continuous play: no Start rally. Point A and Point B are
//                 always on screen and a point needs a hold of about 2 s
//                 (hooks/useHoldToConfirm POINT_HOLD_MS) against a misclick;
//                 "Decision change / Replay" also records a replayed rally.
// The first rally of a set still starts with Start set (line-ups, signatures,
// liberos, the set's start time). Both write the same events (a point in
// continuous play writes its rally_start right before it), so the mode can be
// switched during a match.

export const RALLY_MODES = Object.freeze(['rallies', 'continuous'])
export const RALLY_MODE_KEY = 'rallyMode'

/** This device's mode; 'rallies' when never set or unreadable. */
export function readRallyMode(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(RALLY_MODE_KEY) === 'continuous' ? 'continuous' : 'rallies'
  } catch {
    return 'rallies'
  }
}

/** Remember the mode on this device (an unknown value keeps 'rallies'). */
export function storeRallyMode(mode, storage = globalThis.localStorage) {
  const value = mode === 'continuous' ? 'continuous' : 'rallies'
  try {
    storage?.setItem(RALLY_MODE_KEY, value)
  } catch {
    // private mode / full storage: the choice still holds for this page
  }
  return value
}
