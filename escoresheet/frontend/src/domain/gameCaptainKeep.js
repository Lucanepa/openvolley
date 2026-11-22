// "Keep as game captain" (owner 2026-11-22): a switch in the scorer's
// game-captain dialog. While it is on for a team, the player last chosen as
// game captain is designated again WITHOUT the dialog whenever the app would
// ask (the team captain is off court and no acting game captain is among the
// six, FIVB 5.1.2) and that player is on court. The dialog comes back only
// when he is not on court, or once the switch is off. A libero team captain
// leaves the court at almost every rotation: this is what spares the scorer
// the same question each time.
//
// Stored on the match row, next to the fields of lineupEntry.js:
//   <team>RememberedCourtCaptain  the player last chosen (already there: the
//                                 dialog proposes him, "Last")
//   <team>KeepCourtCaptain        true while the switch is on
// so the kept player is always the remembered one, and a reload, a second
// tab or a backup restore keeps both. The designation events carry it too
// (payload.keep: true while it is on), the copy a device that continues the
// match from the server is rebuilt from (keepFieldsFromEvents): the server's
// match row has no column for it.
//
// An automatic designation is the same 'court_captain_designation' event as a
// chosen one (with auto: true), so the scoresheet, the remarks, the referee
// and the benches follow, and Undo takes it back like any other.

const isBlank = (v) => v == null || String(v).trim() === ''
const sameNumber = (a, b) => !isBlank(a) && !isBlank(b) && String(Number(a)) === String(Number(b))

export const courtCaptainField = (team) => (team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain')
export const rememberedCourtCaptainField = (team) => (team === 'home' ? 'homeRememberedCourtCaptain' : 'awayRememberedCourtCaptain')
export const keepCourtCaptainField = (team) => (team === 'home' ? 'homeKeepCourtCaptain' : 'awayKeepCourtCaptain')

/** Whether "Keep as game captain" is on for `team`. */
export function keepsGameCaptain(match, team) {
  return match?.[keepCourtCaptainField(team)] === true
}

/** The kept game captain of `team` (shirt number as stored), or null when the switch is off. */
export function keptGameCaptain(match, team) {
  if (!keepsGameCaptain(match, team)) return null
  const n = match?.[rememberedCourtCaptainField(team)]
  return isBlank(n) ? null : n
}

/**
 * The player to designate without asking, where the app would ask for a game
 * captain: the kept one when he is on court (`playersOnCourt`: the six as
 * shown, a libero included), else null (the dialog asks).
 */
export function automaticGameCaptain({ match, team, playersOnCourt = [] }) {
  const kept = keptGameCaptain(match, team)
  if (kept == null) return null
  return (playersOnCourt || []).some(n => sameNumber(n, kept)) ? kept : null
}

/**
 * The game captain chosen in the dialog, with the switch as it was at the tap.
 * @returns {{ matchUpdate: object, payload: object }} the match fields and the
 *   'court_captain_designation' payload; the payload's previous* fields are
 *   what Undo puts back (Scoreboard reverseEventSideEffects).
 */
export function chosenGameCaptain({ match, team, playerNumber, keep = false }) {
  const court = match?.[courtCaptainField(team)]
  const remembered = match?.[rememberedCourtCaptainField(team)]
  const wasKept = keepsGameCaptain(match, team)
  const payload = {
    team,
    playerNumber,
    previousCourtCaptain: isBlank(court) ? null : court,
    keep: keep === true
  }
  if (!sameNumber(remembered, playerNumber)) payload.previousRememberedCourtCaptain = isBlank(remembered) ? null : remembered
  if (wasKept !== (keep === true)) payload.previousKeepCourtCaptain = wasKept
  return {
    matchUpdate: {
      [courtCaptainField(team)]: playerNumber,
      [rememberedCourtCaptainField(team)]: playerNumber,
      [keepCourtCaptainField(team)]: keep === true
    },
    payload
  }
}

/** The automatic designation of the kept player (automaticGameCaptain). */
export function automaticDesignation({ match, team, playerNumber }) {
  const court = match?.[courtCaptainField(team)]
  return {
    matchUpdate: { [courtCaptainField(team)]: playerNumber },
    payload: { team, playerNumber, previousCourtCaptain: isBlank(court) ? null : court, keep: true, auto: true }
  }
}

/**
 * The remembered game captain and the switch of each team, from the match's
 * designation events: the newest one per team names the player, and its
 * payload.keep the switch. For a match row rebuilt from the server's copy,
 * which has neither (backupManager localMatchRowFromCloud). Teams without a
 * designation are left out.
 */
export function keepFieldsFromEvents(events = []) {
  const out = {}
  for (const team of ['home', 'away']) {
    let latest = null
    for (const e of events || []) {
      if (e?.type !== 'court_captain_designation' || e.payload?.team !== team || isBlank(e.payload?.playerNumber)) continue
      if (!latest || (Number(e.seq) || 0) > (Number(latest.seq) || 0)) latest = e
    }
    if (!latest) continue
    out[rememberedCourtCaptainField(team)] = latest.payload.playerNumber
    out[keepCourtCaptainField(team)] = latest.payload.keep === true
  }
  return out
}

/**
 * The switch turned on or off where nobody is designated (the Game captain
 * button while the role is held): the newest designation of the team says so
 * too (payload.keep), an edit the server's copy of the event gets, so a
 * device continuing the match from it reads the switch as it is
 * (keepFieldsFromEvents). null when there is nothing to change.
 * @returns {{ id: any, payload: object }|null}
 */
export function keepEdit(events = [], team, keep) {
  let latest = null
  for (const e of events || []) {
    if (e?.type !== 'court_captain_designation' || e.payload?.team !== team) continue
    if (!latest || (Number(e.seq) || 0) > (Number(latest.seq) || 0)) latest = e
  }
  if (!latest || (latest.payload?.keep === true) === (keep === true)) return null
  return { id: latest.id, payload: { ...latest.payload, keep: keep === true } }
}

// ---------------------------------------------------------------------------
// The set end ends a game captain's role (FIVB 5.1.2: until he is replaced,
// the team captain returns, or the set ends; owner 22.11). The set end clears
// the acting ones and keeps them on its event (payload.previousCourtCaptains)
// for Undo and Reopen set. The last game captain (remembered, "Last") and the
// switch stay: the next set designates again, by the line-up dialog, the
// Game captain dialog or "Keep as game captain", with a new designation event
// of that set.
// ---------------------------------------------------------------------------

/** The acting game captains on the match row, by team: { home?, away? }. */
export function actingCourtCaptains(match) {
  const out = {}
  for (const team of ['home', 'away']) {
    const n = match?.[courtCaptainField(team)]
    if (!isBlank(n)) out[team] = n
  }
  return out
}

/** The match fields that clear them (only the teams that had one). */
export function courtCaptainsCleared(previous = {}) {
  const out = {}
  for (const team of ['home', 'away']) if (previous && Object.prototype.hasOwnProperty.call(previous, team)) out[courtCaptainField(team)] = null
  return out
}

/** The match fields that put them back (a set end undone or reopened). */
export function courtCaptainsRestored(previous) {
  const out = {}
  if (!previous || typeof previous !== 'object') return out
  for (const team of ['home', 'away']) if (Object.prototype.hasOwnProperty.call(previous, team)) out[courtCaptainField(team)] = previous[team] ?? null
  return out
}
