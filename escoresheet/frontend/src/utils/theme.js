import { useSyncExternalStore } from 'react'

/**
 * Colour theme of every OpenVolley page: light (the default), dark, or eink
 * (greyscale, paper white and ink black: for a screen in full sun).
 *
 * The choice lives in localStorage under THEME_KEY and shows as
 * <html data-theme="dark|eink"> (no attribute for light). The boot script
 * (theme-boot.js, in each page's <head>) sets the attribute before the first
 * paint and follows changes made in another tab (scorer and referee view on
 * one laptop); this module changes it at run time. The looks themselves are
 * at the end of tailwind.css.
 */
export const THEMES = ['light', 'dark', 'eink']
export const THEME_KEY = 'theme'

const listeners = new Set()

export function getTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return THEMES.includes(stored) ? stored : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'dark' || theme === 'eink') root.setAttribute('data-theme', theme)
  else root.removeAttribute('data-theme')
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'light'
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    // Storage blocked: the theme still applies to this page.
  }
  applyTheme(next)
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  const onStorage = (e) => { if (e.key === THEME_KEY || e.key === null) fn() }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

/** The current theme; re-renders when it changes here or in another tab. */
export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, () => 'light')
}
