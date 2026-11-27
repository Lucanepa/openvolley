// Match setup › Edit roster › "Roster import" (owner 27.11.2026: one switch between
// the three ways instead of a separate photo button): Remote (the coach uploads
// with the upload PIN, or the team sends from the manager page), PDF (a roster
// PDF or the Einsatzliste on this device), Photo (a photo of the printed list,
// read on this device). The last way chosen is kept on this device.

/** Where the scorer's last choice is kept on this device. */
export const ROSTER_IMPORT_MODE_KEY = 'ov.rosterImportMode'
export const ROSTER_IMPORT_MODES = ['remote', 'pdf', 'photo']

/** The way chosen last on this device ('remote' | 'pdf' | 'photo'), or null. */
export function readRosterImportMode() {
  try {
    const v = localStorage.getItem(ROSTER_IMPORT_MODE_KEY)
    return ROSTER_IMPORT_MODES.includes(v) ? v : null
  } catch {
    return null
  }
}

export function saveRosterImportMode(mode) {
  if (!ROSTER_IMPORT_MODES.includes(mode)) return
  try { localStorage.setItem(ROSTER_IMPORT_MODE_KEY, mode) } catch { /* private mode: this session only */ }
}

/**
 * The way the roster import shows when the scorer has not picked one for this
 * team yet: the one chosen last on this device, when the match offers it
 * (Remote: not in a guest match); else Remote for an official match with a game
 * number (the team uploads with the PIN or sends its roster for that game);
 * else PDF.
 * @param {{ remembered?: string|null, remoteOffered?: boolean, officialGame?: boolean }} o
 */
export function rosterImportModeFor({ remembered = null, remoteOffered = true, officialGame = false } = {}) {
  if (ROSTER_IMPORT_MODES.includes(remembered) && (remembered !== 'remote' || remoteOffered)) return remembered
  return remoteOffered && officialGame ? 'remote' : 'pdf'
}
