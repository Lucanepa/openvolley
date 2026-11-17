/**
 * The desktop app's own route to the live page for TVs (utils/globalLive.js).
 *
 * The browser and the phone and tablet apps score over the cloud relay, which
 * feeds the page itself; a venue relay (Node server.js) forwards its courts to
 * the cloud. The desktop app's relay (src-tauri relay.rs) does neither, so the
 * desktop scorer sends its court summary to the cloud over HTTPS:
 * POST /api/global/live/<code>, at most one request per match every PUSH_MS
 * (the newest state wins), never offline, failures ignored. Its origin
 * (tauri://localhost) is one the cloud trusts.
 */
import { getCloudApiUrl } from './backendConfig'
import { detectAppPlatform } from './openAppWindow'
import { courtTokenFor, getLiveCourt } from './globalLive'

export const PUSH_MS = 2000
const SUMMARY_FIELDS = ['team_a_name', 'team_a_short', 'team_a_color', 'team_b_name', 'team_b_short', 'team_b_color', 'sets_won_a', 'sets_won_b', 'points_a', 'points_b', 'current_set', 'best_of', 'side_a', 'serving_team', 'match_status', 'timeout_active', 'set_interval_active']

/** Only the desktop app pushes (the others reach the page through a relay). */
export const pushesGlobalLive = (win = typeof window !== 'undefined' ? window : undefined) => detectAppPlatform(win) === 'tauri'

const slots = new Map() // matchId -> { timer, latest }

export function pickSummary(liveState) {
  const out = {}
  for (const k of SUMMARY_FIELDS) if (liveState && k in liveState) out[k] = liveState[k]
  return out
}

async function send({ code, match, liveState, db, matchId, fetchImpl }) {
  const url = getCloudApiUrl(`/api/global/live/${code}`)
  const court = await courtTokenFor(match)
  if (!url || !court) return
  const [home, away, sets] = await Promise.all([
    match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
    match.awayTeamId ? db.teams.get(match.awayTeamId) : null,
    db.sets.where('matchId').equals(matchId).toArray()
  ])
  const body = {
    court,
    screen: getLiveCourt(),
    liveState: pickSummary(liveState),
    match: { coinTossTeamA: match.coinTossTeamA ?? null, hall: match.hall ?? match.venue ?? null, scheduledAt: match.scheduledAt ?? null, gameN: match.gameN ?? null },
    homeTeam: { name: home?.name ?? null },
    awayTeam: { name: away?.name ?? null },
    sets: (sets || []).filter((x) => x?.finished === true).sort((a, b) => a.index - b.index).slice(0, 5).map((x) => ({ index: x.index, homePoints: x.homePoints, awayPoints: x.awayPoints, finished: true }))
  }
  await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' })
}

/** Queue the match's newest live state for the cloud page (throttled per match). */
export function pushGlobalLive({ code, match, liveState, db, matchId, fetchImpl = (...a) => fetch(...a), online = () => typeof navigator === 'undefined' || navigator.onLine !== false }) {
  if (!code || !match || !liveState || !online()) return
  const slot = slots.get(matchId)
  if (slot) { slot.latest = { code, match, liveState }; return }
  const fresh = { latest: null, timer: null }
  slots.set(matchId, fresh)
  send({ code, match, liveState, db, matchId, fetchImpl }).catch(() => { /* offline or refused: the page waits */ })
  fresh.timer = setTimeout(() => {
    slots.delete(matchId)
    if (fresh.latest) pushGlobalLive({ ...fresh.latest, db, matchId, fetchImpl, online })
  }, PUSH_MS)
}

/** Tests only */
export function resetGlobalLivePush() {
  for (const s of slots.values()) clearTimeout(s.timer)
  slots.clear()
}
