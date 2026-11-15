import { useCallback, useSyncExternalStore } from 'react'
import { getSponsorsOption, setSponsorsOption, SPONSORS_OPTION_EVENT, SPONSORS_OPTION_KEY } from '../domain/sponsors'

// The "Sponsors on clothing" option (domain/sponsors.js), followed live: the
// options dialogs, Match setup, the match end and Edit match info read the
// same value and redraw when it changes here or in another window.
function subscribe(onChange) {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e) => { if (!e || e.key === null || e.key === SPONSORS_OPTION_KEY) onChange() }
  window.addEventListener(SPONSORS_OPTION_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(SPONSORS_OPTION_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** @returns {[boolean, (on: boolean) => void]} */
export function useSponsorsOption() {
  const on = useSyncExternalStore(subscribe, getSponsorsOption, () => false)
  const set = useCallback((value) => setSponsorsOption(value), [])
  return [on, set]
}
