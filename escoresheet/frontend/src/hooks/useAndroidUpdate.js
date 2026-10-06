import { useSyncExternalStore } from 'react'
import {
  checkAndroidUpdate,
  dismissAndroidUpdate,
  downloadApk,
  getAndroidUpdateSnapshot,
  getFromFdroid,
  isNewer,
  openInFdroid,
  setUpdateNotify,
  subscribeAndroidUpdate,
} from '../utils/androidUpdate'
import { getLiveMatch, onLiveMatchChange } from '../utils/appLifecycle'

const actions = {
  checkNow: checkAndroidUpdate,
  setNotify: setUpdateNotify,
  dismiss: dismissAndroidUpdate,
  openInFdroid,
  getFromFdroid,
  downloadApk,
}

/**
 * The Android app's update state (src/utils/androidUpdate.js) for the notice
 * and the options. `active` is false outside the Android app.
 * - newer: a newer version is known
 * - showNotice: the home-screen notice may show it now (no live match, not
 *   dismissed). A version found during a match waits here until it ends.
 */
export default function useAndroidUpdate() {
  const state = useSyncExternalStore(subscribeAndroidUpdate, getAndroidUpdateSnapshot, getAndroidUpdateSnapshot)
  const live = useSyncExternalStore(onLiveMatchChange, getLiveMatch, getLiveMatch)
  const newer = state.active && isNewer(state.latest)
  const quiet = live !== 'none'
  return {
    ...state,
    live,
    newer,
    showNotice: newer && !quiet && state.dismissed !== state.latest?.versionName,
    showAsk: state.active && state.asking && !quiet,
    ...actions,
  }
}
