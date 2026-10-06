/**
 * The desktop app's automatic updates, for the page (src-tauri/src/updater.rs
 * decides; utils/desktopUpdate.js explains). Active only in the desktop app's
 * scoretable window; anywhere else `active` is false and nothing is called.
 *
 * - `status`: the app's status (update_status, then every `ov-update` event)
 * - `checkNow()`: "Check for updates"
 * - `installNow()`: "Restart and update"; while the app's gate is closed it
 *   returns `{ ok: false, error: { code: 'blocked', blockers } }` and nothing
 *   happens
 * - `setPrefs({ autoCheck, autoInstall })`
 *
 * A sign-in (AuthContext fires `ov-signed-in`) asks the app to check; the app
 * skips it when it checked in the last 15 minutes or automatic checks are off.
 *
 * Every status carries the app's `seq`: an answer computed before a newer
 * event (the page just loaded and asks while it reports that the match is
 * over) never replaces the newer status.
 */

import { useCallback, useEffect, useState } from 'react'
import { isDesktopScoretable } from '../utils/appLifecycle'
import { SIGNED_IN_EVENT, UPDATE_EVENT } from '../utils/desktopUpdate'

function invoker(win) {
  try {
    const internals = win?.__TAURI_INTERNALS__
    return typeof internals?.invoke === 'function' ? internals.invoke.bind(internals) : null
  } catch {
    return null
  }
}

// One sign-in listener for the window, however many components use the hook.
const signInHooks = new WeakMap()

function hookSignIn(win, invoke) {
  const entry = signInHooks.get(win)
  if (entry) {
    entry.count += 1
  } else {
    const onSignIn = () => {
      Promise.resolve(invoke('update_check_now', { reason: 'signIn' })).catch((e) => console.warn('[update] sign-in check failed', e))
    }
    win.addEventListener(SIGNED_IN_EVENT, onSignIn)
    signInHooks.set(win, { count: 1, onSignIn })
  }
  return () => {
    const e = signInHooks.get(win)
    if (!e) return
    e.count -= 1
    if (e.count <= 0) {
      win.removeEventListener(SIGNED_IN_EVENT, e.onSignIn)
      signInHooks.delete(win)
    }
  }
}

/** The newer of two statuses (by the app's `seq`; one without counts as 0). */
export function newerStatus(prev, next) {
  if (!next || typeof next !== 'object') return prev
  if (!prev) return next
  return (Number(next.seq) || 0) >= (Number(prev.seq) || 0) ? next : prev
}

export function useDesktopUpdate({ win = typeof window !== 'undefined' ? window : undefined } = {}) {
  const active = isDesktopScoretable(win)
  const [status, setRawStatus] = useState(null)
  const setStatus = useCallback((next) => setRawStatus((prev) => newerStatus(prev, next)), [])

  useEffect(() => {
    if (!active) return undefined
    const invoke = invoker(win)
    let alive = true
    Promise.resolve(invoke('update_status'))
      .then((s) => { if (alive) setStatus(s) })
      .catch((e) => console.warn('[update] update_status failed', e))
    const onUpdate = (event) => {
      if (event?.detail && typeof event.detail === 'object') setStatus(event.detail)
    }
    win.addEventListener(UPDATE_EVENT, onUpdate)
    const unhookSignIn = hookSignIn(win, invoke)
    return () => {
      alive = false
      win.removeEventListener(UPDATE_EVENT, onUpdate)
      unhookSignIn()
    }
  }, [active, win, setStatus])

  const call = useCallback(async (cmd, args) => {
    const invoke = invoker(win)
    if (!invoke) return null
    const s = await invoke(cmd, args)
    if (s && typeof s === 'object') setStatus(s)
    return s
  }, [win, setStatus])

  const checkNow = useCallback(
    () => call('update_check_now', { reason: 'manual' }).catch((e) => { console.warn('[update] check failed', e); return null }),
    [call],
  )

  const installNow = useCallback(async () => {
    try {
      await call('update_install_now')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error && typeof error === 'object' ? error : { code: 'installFailed' } }
    }
  }, [call])

  const setPrefs = useCallback(
    (prefs) => call('update_set_prefs', prefs).catch((e) => { console.warn('[update] settings failed', e); return null }),
    [call],
  )

  return { active, status, checkNow, installNow, setPrefs }
}

export default useDesktopUpdate
