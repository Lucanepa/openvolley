/**
 * Pure roster checks for the mid-match "reopen roster" editor — no React, no
 * Dexie. Players are matched by NUMBER everywhere in the event log (lineups,
 * substitutions, libero replacements, sanctions), so a roster edited during the
 * match must keep numbers valid and unique and must not remove or renumber a
 * player the record already refers to. Senior 6-6: max 2 active liberos
 * (FIVB 19.1.1), one team captain (FIVB 5.1).
 */

const ACTIVE_LIBERO = new Set(['libero1', 'libero2', 'redesignated'])

/** Player numbers of a team referred to by the match events. */
export function referencedPlayerNumbers(events, teamKey) {
  const nums = new Set()
  const add = (n) => { if (n !== undefined && n !== null && n !== '') nums.add(String(n)) }
  for (const e of events || []) {
    const p = e.payload
    if (!p || p.team !== teamKey) continue
    if (e.type === 'lineup') {
      for (const n of Object.values(p.lineup || {})) add(n)
      if (p.liberoSubstitution) { add(p.liberoSubstitution.liberoNumber); add(p.liberoSubstitution.playerNumber) }
    } else if (e.type === 'substitution') {
      add(p.playerIn); add(p.playerOut)
    } else if (e.type === 'libero_entry' || e.type === 'libero_exit' || e.type === 'libero_exchange') {
      add(p.liberoIn); add(p.liberoOut); add(p.playerIn); add(p.playerOut)
    } else if (e.type === 'libero_unable' || e.type === 'libero_redesignation') {
      add(p.liberoNumber); add(p.unableLiberoNumber); add(p.newLiberoNumber)
    } else if (e.type === 'sanction' && (p.playerType === undefined || p.playerType === 'player')) {
      add(p.playerNumber)
    } else if (e.type === 'court_captain_designation') {
      add(p.playerNumber)
    }
  }
  return nums
}

/**
 * Validate a reopened roster before saving.
 * @param {Array} editedPlayers rows from the editor ({id?, number, libero, isCaptain})
 * @param {Array} originalPlayers the roster when the editor opened
 * @param {Set<string>} referencedNumbers numbers the event log refers to
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateReopenedRoster(editedPlayers, originalPlayers, referencedNumbers = new Set()) {
  const errors = []
  const edited = editedPlayers || []

  const seen = new Map()
  for (const p of edited) {
    const n = Number(p.number)
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      errors.push(`Player numbers must be 1-99 (found "${p.number ?? ''}"${p.lastName ? ` for ${p.lastName}` : ''}).`)
      continue
    }
    seen.set(n, (seen.get(n) || 0) + 1)
  }
  for (const [n, count] of seen) {
    if (count > 1) errors.push(`Number #${n} is used ${count} times.`)
  }

  const liberos = edited.filter(p => ACTIVE_LIBERO.has(p.libero)).length
  if (liberos > 2) errors.push(`At most 2 liberos (found ${liberos}).`)
  const captains = edited.filter(p => p.isCaptain).length
  if (captains > 1) errors.push(`Only one team captain (found ${captains}).`)

  // Players already in the record cannot disappear or change number
  const editedById = new Map(edited.filter(p => p.id != null).map(p => [p.id, p]))
  for (const orig of originalPlayers || []) {
    const num = String(orig.number)
    if (!referencedNumbers.has(num)) continue
    const now = editedById.get(orig.id)
    if (!now) errors.push(`#${num} appears in the match record and cannot be removed.`)
    else if (String(now.number) !== num) errors.push(`#${num} appears in the match record and cannot be renumbered.`)
  }

  return { valid: errors.length === 0, errors }
}
