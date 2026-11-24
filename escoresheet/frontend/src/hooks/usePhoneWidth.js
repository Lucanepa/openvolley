import { useSyncExternalStore } from 'react'

// True while the window is as narrow as a phone held upright (under 640 CSS
// px, Tailwind's `sm`). For the few layouts CSS classes cannot switch, such as
// a table's fixed column widths. False without matchMedia (tests, SSR).
export const PHONE_WIDTH_QUERY = '(max-width: 639px)'

function getQuery() {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_WIDTH_QUERY) : null
}

function subscribe(onChange) {
  const mq = getQuery()
  if (!mq?.addEventListener) return () => {}
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

function getSnapshot() {
  return getQuery()?.matches ?? false
}

function getServerSnapshot() {
  return false
}

export function usePhoneWidth() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export default usePhoneWidth
