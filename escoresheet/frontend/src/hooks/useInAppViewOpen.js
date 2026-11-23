import { useSyncExternalStore } from 'react'
import { isInAppViewOpen, onInAppViewChange } from '../utils/openAppWindow'

const closedOnServer = () => false

/**
 * Whether the Android app's in-app view (utils/openAppWindow showInAppView)
 * covers the screen. A clock or a poll nobody can see while it is open
 * pauses on it; nothing that records, sends or backs up a match may.
 */
export function useInAppViewOpen () {
  return useSyncExternalStore(onInAppViewChange, isInAppViewOpen, closedOnServer)
}

export default useInAppViewOpen
