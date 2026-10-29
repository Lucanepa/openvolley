/**
 * Pure roster checks for the mid-match "reopen roster" editor — no React, no
 * Dexie. Players are matched by NUMBER everywhere in the event log (lineups,
 * substitutions, libero replacements, sanctions), so a roster edited during the
 * match must keep numbers valid and unique and must not remove or renumber a
 * player the record already refers to. Senior 6-6: max 2 active liberos
 * (FIVB 19.1.1), one team captain (FIVB 5.1).
 */

const ACTIVE_LIBERO = new Set(['libero1', 'libero2', 'redesignated'])

/** A shirt number: a whole number from 1 to 99 (number or digit string). */
export function isShirtNumber(n) {
  if (n === null || n === undefined || n === '') return false
  const v = Number(n)
  return Number.isInteger(v) && v >= 1 && v <= 99
}

/**
 * The digits of a shirt number as typed. The number inputs filtered keys in
 * onKeyPress only, which touch keyboards (IME), autofill and paste never
 * fire: '1.5' (the '.' next to the digits on a tablet keypad, meant as 15)
 * was stored as 1.5, and the cloud refused every rally that player served
 * (events.serve_player is an integer column) for good.
 */
export function shirtNumberDigits(value) {
  return String(value ?? '').replace(/\D/g, '')
}

// Where an event of a team holds one of its players' numbers, beside a
// line-up's positions and its libero record (owner 2026-10-29: a number
// changed in the roster is changed for the whole match). Fields an entry
// does not have are skipped.
const LIBERO_FIELDS = ['liberoIn', 'liberoOut', 'playerIn', 'playerOut', 'playerNumber', 'liberoNumber', 'unableLiberoNumber', 'newLiberoNumber']
const NUMBER_FIELDS = {
  substitution: ['playerIn', 'playerOut'],
  libero_entry: LIBERO_FIELDS,
  libero_exit: LIBERO_FIELDS,
  libero_exchange: LIBERO_FIELDS,
  libero_unable: LIBERO_FIELDS,
  libero_redesignation: LIBERO_FIELDS,
  court_captain_designation: ['playerNumber', 'previousCourtCaptain', 'previousRememberedCourtCaptain'],
  bench_injury: ['playerNumber'],
  lineup: ['previousRememberedCourtCaptain']
}

/** A sanction given to a player (on court, on the bench, a libero), not to an official or the team. */
function isPlayerSanction(p) {
  const pt = p?.playerType
  return pt === undefined || pt === null || pt === 'player' || pt === 'bench' || pt === 'libero'
}

/** The number fields of one event (payload keys), without the line-up positions. */
export function numberFieldsOf(e) {
  if (!e?.payload) return []
  if (e.type === 'sanction') return isPlayerSanction(e.payload) ? ['playerNumber'] : []
  return NUMBER_FIELDS[e.type] || []
}

/** Player numbers of a team referred to by the match events. */
export function referencedPlayerNumbers(events, teamKey) {
  const nums = new Set()
  const add = (n) => { if (n !== undefined && n !== null && n !== '') nums.add(String(n)) }
  const visit = (e) => {
    const p = e?.payload
    if (!p || p.team !== teamKey) return
    if (e.type === 'lineup') {
      for (const n of Object.values(p.lineup || {})) add(n)
      if (p.liberoSubstitution) { add(p.liberoSubstitution.liberoNumber); add(p.liberoSubstitution.playerNumber) }
    }
    for (const f of numberFieldsOf(e)) add(p[f])
  }
  for (const e of events || []) {
    visit(e)
    // a decision change keeps the rows it removed, to put them back on undo
    if (e?.type === 'decision_change') for (const r of e.payload?.removedSubEvents || []) visit(r)
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
 * once (so 5->12 and 12->... never chain): line-ups and their libero record,
 * substitutions, libero replacements, sanctions of players, game captains
 * (with the numbers an undo puts back), injuries, the rows a decision change
 * keeps for its undo, the automatic remark of an entry and the state
 * snapshot stored on the event. A value keeps its type (line-ups store
 * strings, substitutions often numbers).
 * @param {Array} events
 * @param {'home'|'away'} teamKey
 * @param {Array<{from:string|number, to:string|number}>} renumbers
 * @returns {Array<{id:any, payload:object, stateSnapshot?:object, autoRemark?:{from:string, to:string}}>}
 *   updated payloads (and snapshots) of the changed events; autoRemark: the
 *   entry's remark line before and after (to be rewritten in the remarks too)
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

  const renumberPayload = (e) => {
    const p = e?.payload
    if (!p || p.team !== teamKey) return null
    let changed = false
    const out = { ...p }
    if (e.type === 'lineup') {
      if (p.lineup) {
        const lineup = {}
        for (const [pos, n] of Object.entries(p.lineup)) {
          lineup[pos] = swap(n)
          if (lineup[pos] !== n) changed = true
        }
        out.lineup = lineup
      }
      if (p.liberoSubstitution) {
        const ls = { ...p.liberoSubstitution }
        for (const f of ['liberoNumber', 'playerNumber']) {
          if (!(f in ls)) continue
          const v = swap(ls[f])
          if (v !== ls[f]) { ls[f] = v; changed = true }
        }
        out.liberoSubstitution = ls
      }
    }
    for (const f of numberFieldsOf(e)) {
      if (!(f in out)) continue
      const v = swap(out[f])
      if (v !== out[f]) { out[f] = v; changed = true }
    }
    if (typeof p.autoRemark === 'string') {
      const text = renumberRemarkText(p.autoRemark, map)
      if (text !== p.autoRemark) { out.autoRemark = text; changed = true }
    }
    return changed ? out : null
  }

  const updates = []
  for (const e of events || []) {
    let payload = renumberPayload(e)
    if (e?.type === 'decision_change' && Array.isArray(e.payload?.removedSubEvents)) {
      let any = false
      const rows = e.payload.removedSubEvents.map(r => {
        const np = renumberPayload(r)
        if (!np) return r
        any = true
        return { ...r, payload: np }
      })
      if (any) payload = { ...(payload || e.payload), removedSubEvents: rows }
    }
    const snapshot = renumberSnapshot(e?.stateSnapshot, teamKey, map)
    if (!payload && !snapshot) continue
    const u = { id: e.id, payload: payload || e.payload }
    if (snapshot) u.stateSnapshot = snapshot
    if (payload && typeof e.payload?.autoRemark === 'string' && payload.autoRemark !== e.payload.autoRemark) {
      u.autoRemark = { from: e.payload.autoRemark, to: payload.autoRemark }
    }
    updates.push(u)
  }
  return updates
}

// A player number in a remark line: "#7", "no. 7", "Nr. 7", "n° 7", "n. 7"
const REMARK_NUMBER = /(#|\bno\.\s?|\bNr\.\s?|n°\s?|\bn\.\s?)(\d{1,2})(?!\d)/g

/** A remark line with the renumbered players' numbers (scores and times stay). */
export function renumberRemarkText(text, renumbers) {
  const map = renumbers instanceof Map ? renumbers : new Map((renumbers || []).map(r => [String(r.from), String(r.to)]))
  if (!text || map.size === 0) return text
  return String(text).replace(REMARK_NUMBER, (m, prefix, n) => (map.has(n) ? `${prefix}${map.get(n)}` : m))
}

/**
 * The state snapshot stored on an event (what the referee and the
 * livescore were last shown), with the team's renumbered players: its
 * line-up discs, server, substitutions and sanctions. null when nothing
 * changes.
 */
export function renumberSnapshot(snapshot, teamKey, map) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const side = (snapshot.teamAKey || 'home') === teamKey ? 'A' : 'B'
  let changed = false
  const swap = (v) => {
    if (v === undefined || v === null || v === '') return v
    const to = map.get(String(v))
    if (to === undefined) return v
    changed = true
    return typeof v === 'number' ? Number(to) : to
  }
  const out = { ...snapshot }
  const lineup = snapshot[`lineup${side}`]
  if (lineup && typeof lineup === 'object') {
    const next = {}
    for (const [pos, d] of Object.entries(lineup)) {
      if (!d || typeof d !== 'object') { next[pos] = d; continue }
      const nd = { ...d }
      for (const f of ['number', 'replacedNumber', 'substitutedFor']) if (f in nd) nd[f] = swap(nd[f])
      next[pos] = nd
    }
    out[`lineup${side}`] = next
  }
  if (snapshot.servingTeam === teamKey && 'serverNumber' in snapshot) out.serverNumber = swap(snapshot.serverNumber)
  for (const key of [`subs${side}`, `sanctions${side}`, `matchTeamSanctions${side}`]) {
    if (!Array.isArray(snapshot[key])) continue
    out[key] = snapshot[key].map(x => {
      if (!x || typeof x !== 'object') return x
      const nx = { ...x }
      for (const f of ['playerIn', 'playerOut', 'player']) if (f in nx) nx[f] = swap(nx[f])
      return nx
    })
  }
  return changed ? out : null
}

/**
 * Numbers the match record refers to that a new roster no longer has (a
 * player renumbered or removed in a roster editor that matches players by
 * number): saving it would leave those entries without their player.
 * @returns {string[]}
 */
export function recordNumbersMissingFrom(events, teamKey, roster) {
  const have = new Set((roster || []).map(p => String(p?.number ?? '')).filter(Boolean))
  return [...referencedPlayerNumbers(events, teamKey)].filter(n => !have.has(n)).sort((a, b) => Number(a) - Number(b))
}
