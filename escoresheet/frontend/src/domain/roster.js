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
 * A player the record already refers to may be RENUMBERED (the common fix of
 * a number typed wrong at setup) when the new number is not used anywhere in
 * the record: the caller rewrites that team's events with
 * renumberPlayerInEvents(). Renumbering onto a number the record already uses
 * would merge two players' histories, so it is refused.
 * @returns {{valid: boolean, errors: string[], renumbers: Array<{from:string, to:string}>}}
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

  // Players already in the record cannot disappear; they may change number
  // only to a number the record does not use yet
  const renumbers = []
  const editedById = new Map(edited.filter(p => p.id != null).map(p => [p.id, p]))
  for (const orig of originalPlayers || []) {
    const num = String(orig.number)
    if (!referencedNumbers.has(num)) continue
    const now = editedById.get(orig.id)
    if (!now) {
      errors.push(`#${num} appears in the match record and cannot be removed. Correct or delete its events in Manual Adjustments first.`)
    } else if (String(now.number) !== num) {
      const to = String(Number(now.number))
      if (referencedNumbers.has(to)) {
        errors.push(`#${num} cannot be renumbered to #${to}: #${to} is already used in the match record. Correct the events in Manual Adjustments instead.`)
      } else {
        renumbers.push({ from: num, to })
      }
    }
  }

  return { valid: errors.length === 0, errors, renumbers }
}

/**
 * Rewrite one team's events after players were renumbered in the roster.
 * Every field referencedPlayerNumbers() reads is rewritten, all renumbers at
 * once (so 5->12 and 12->... never chain). A value keeps its type (lineups
 * store strings, substitutions often numbers).
 * @param {Array} events
 * @param {'home'|'away'} teamKey
 * @param {Array<{from:string|number, to:string|number}>} renumbers
 * @returns {Array<{id:any, payload:object}>} updated payloads of the changed events
 */
export function renumberPlayerInEvents(events, teamKey, renumbers) {
  const map = new Map((renumbers || []).map(r => [String(r.from), String(r.to)]))
  if (map.size === 0) return []
  const swap = (v) => {
    if (v === undefined || v === null || v === '') return v
    const to = map.get(String(v))
    if (to === undefined) return v
    return typeof v === 'number' ? Number(to) : to
  }
  const swapFields = (obj, fields) => {
    let changed = false
    const out = { ...obj }
    for (const f of fields) {
      if (!(f in out)) continue
      const v = swap(out[f])
      if (v !== out[f]) { out[f] = v; changed = true }
    }
    return { out, changed }
  }

  const updates = []
  for (const e of events || []) {
    const p = e.payload
    if (!p || p.team !== teamKey) continue
    let next = null
    if (e.type === 'lineup') {
      let changed = false
      const lineup = {}
      for (const [pos, n] of Object.entries(p.lineup || {})) {
        lineup[pos] = swap(n)
        if (lineup[pos] !== n) changed = true
      }
      let liberoSubstitution = p.liberoSubstitution
      if (liberoSubstitution) {
        const r = swapFields(liberoSubstitution, ['liberoNumber', 'playerNumber'])
        if (r.changed) { liberoSubstitution = r.out; changed = true }
      }
      if (changed) next = { ...p, ...(p.lineup ? { lineup } : {}), ...(p.liberoSubstitution ? { liberoSubstitution } : {}) }
    } else {
      let fields = null
      if (e.type === 'substitution') fields = ['playerIn', 'playerOut']
      else if (e.type === 'libero_entry' || e.type === 'libero_exit' || e.type === 'libero_exchange') fields = ['liberoIn', 'liberoOut', 'playerIn', 'playerOut']
      else if (e.type === 'libero_unable' || e.type === 'libero_redesignation') fields = ['liberoNumber', 'unableLiberoNumber', 'newLiberoNumber']
      else if (e.type === 'sanction' && (p.playerType === undefined || p.playerType === 'player')) fields = ['playerNumber']
      else if (e.type === 'court_captain_designation') fields = ['playerNumber']
      if (fields) {
        const r = swapFields(p, fields)
        if (r.changed) next = r.out
      }
    }
    if (next) updates.push({ id: e.id, payload: next })
  }
  return updates
}
