/**
 * Which app this page is: every entry (main.jsx, referee-main.jsx, ...) says
 * so first thing, before React renders.
 *
 * The scoretable's automatic backups (hooks/useAutoBackup, the browser
 * download in utils/backupManager) run only on the scoretable page. The
 * referee, bench, livescore and scoresheet pages a tablet or phone opens from
 * the "Connect tablets" QR codes must never save a match file, whatever they
 * import and whatever that browser's settings say. An unmarked page counts as
 * not the scoretable.
 */

export const SCORER_ENTRY = 'scorer'

const KEY = '__OV_APP_ENTRY__'

/** @param {'scorer'|'referee'|'bench'|'livescore'|'scoresheet'|'upload_roster'|'manager'|string} name */
export function setAppEntry(name) {
  try {
    globalThis[KEY] = name
  } catch {
    // a frozen global object: the page then counts as unmarked
  }
}

export function getAppEntry() {
  try {
    return globalThis[KEY] || null
  } catch {
    return null
  }
}

/** True only on the scoretable page (main.jsx). */
export const isScorerEntry = () => getAppEntry() === SCORER_ENTRY
