/**
 * The referee tablet's live scoresheet: the scoresheet viewer's input
 * (scoresheet_pdf/App_Scoresheet `matchData`) built from the relay bundle the
 * tablet already holds, instead of the scorer device's IndexedDB
 * (ScoresheetApp MatchIdViewer) or the approved file (?date&game).
 *
 * The bundle is the scorer's Dexie match as the relay hands it out
 * (backend/server.js wireBundle, electron/lanRelayCore.cjs toWireBundle):
 * { access, match, homeTeam, awayTeam, homePlayers, awayPlayers, sets,
 * events, liveState? }. The relays leave out, also from a 'full' bundle,
 * every PIN, the officials, every signature, the account approval record and
 * people's dates of birth (backend/lib/publicColumns.js): the sheet shows its
 * boxes for them empty.
 */

/** Only a 'full' bundle (the referee PIN proved) has rosters and events. */
export function bundleHasFullAccess(bundle) {
  return !!bundle && typeof bundle === 'object' && bundle.access === 'full' && !!bundle.match && typeof bundle.match === 'object'
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])

/** Events in the scorer's order (seq; a decimal seq is a point's sub-event), stable for equal or missing seq. */
function bySeq(events) {
  return list(events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = Number(a.e.seq)
      const sb = Number(b.e.seq)
      const fa = Number.isFinite(sa)
      const fb = Number.isFinite(sb)
      if (fa && fb && sa !== sb) return sa - sb
      if (fa !== fb) return fa ? -1 : 1
      return a.i - b.i
    })
    .map(({ e }) => e)
}

/** Point events of one set, per team. */
function pointsOf(events, setIndex) {
  const pts = { home: 0, away: 0 }
  for (const e of events) {
    if (e.type === 'point' && Number(e.setIndex) === setIndex && (e.payload?.team === 'home' || e.payload?.team === 'away')) pts[e.payload.team]++
  }
  return pts
}

/**
 * The scoresheet input for a 'full' relay bundle, or null (no bundle, a
 * 'summary' bundle, no match).
 *
 * - sets by index, events by seq (the order ScoresheetApp reads them from Dexie);
 * - a set still running takes its score from its point events: the tablet
 *   lays a newer live-state push's score over the bundle's set
 *   (serverDataSync.applyNewerLiveState), up to one sync ahead of the events
 *   it holds, and the sheet would warn "the points recorded do not match the
 *   set score" until the scorer's next sync. Finished sets stay as recorded;
 * - teams and players are passed as they are (the sheet formats names and
 *   sorts by shirt number itself); a team sent as a plain name becomes { name }.
 * @param {object|null|undefined} bundle
 * @returns {null|{ match: object, homeTeam: object|null, awayTeam: object|null, homePlayers: object[], awayPlayers: object[], sets: object[], events: object[], sanctions: [] }}
 */
export function scoresheetInputFromBundle(bundle) {
  if (!bundleHasFullAccess(bundle)) return null
  const events = bySeq(bundle.events)
  const sets = list(bundle.sets)
    .slice()
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
    .map((s) => {
      if (s.finished) return s
      const index = Number(s.index)
      const pts = pointsOf(events, index)
      if (pts.home + pts.away === 0) return s
      if (s.homePoints === pts.home && s.awayPoints === pts.away) return s
      return { ...s, homePoints: pts.home, awayPoints: pts.away }
    })
  const team = (t) => (typeof t === 'string' ? { name: t } : (t && typeof t === 'object' ? t : null))
  return {
    match: bundle.match,
    homeTeam: team(bundle.homeTeam),
    awayTeam: team(bundle.awayTeam),
    homePlayers: list(bundle.homePlayers),
    awayPlayers: list(bundle.awayPlayers),
    sets,
    events,
    sanctions: []
  }
}
