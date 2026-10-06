import { useSyncExternalStore } from 'react'
import { FORM_STACK_QUERY } from '../utils/formLayout'

// True while the scorer app's forms show one field per row (a tablet held
// upright, see utils/formLayout.js). For the few things CSS cannot switch,
// such as an <option>'s text; everything else is in the portrait block of
// tailwind.css. False without matchMedia (tests, SSR).

function getQuery() {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(FORM_STACK_QUERY) : null
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

export function useFormStack() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
