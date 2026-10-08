// A screen's data, read before App switches to the screen.
//
// Match Setup and Match End read their data after they mounted, so they
// first showed an empty or "Not set" page and filled in over the next
// renders (laptop run 2026-10-08, OV-14 / OV-18). App now reads the data
// first (preload) and switches after; the screen takes it at mount
// (usePreloaded), so its first paint is filled and the screen before it
// stays until then. A screen opened without a preload loads as before.
//
// A read is kept until the screen has mounted with it, at most a moment.
import { useLayoutEffect, useState } from 'react'

const reads = new Map()
const KEEP_MS = 1000

/** Reads `read()` for the screen of `key`; never throws (the screen then loads by itself). */
export async function preload(key, read) {
  try {
    const entry = { value: await read() }
    reads.set(key, entry)
    setTimeout(() => {
      if (reads.get(key) === entry) reads.delete(key)
    }, KEEP_MS)
    return entry.value
  } catch (err) {
    console.warn('[preload] could not read', key, err?.message || err)
    return undefined
  }
}

/** The value preloaded for `key` when this component mounted, or undefined. */
export function usePreloaded(key) {
  const [entry] = useState(() => (key != null ? reads.get(key) : undefined))
  useLayoutEffect(() => {
    if (key != null) reads.delete(key)
  }, [key])
  return entry?.value
}
