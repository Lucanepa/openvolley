// Swiss Volley Game Center client (games with referees, standings) — the public
// schedule the regional sites (www.svrz.ch, www.svra.ch, …) show, read the way
// their pages read it: Next.js server actions, POSTed to /game-center with a
// `Next-Action: <id>` header and a JSON array body. The answer is React flight
// text; line `1:` is the value. No login, and none of it touches VolleyManager's
// server (185.195.199.53), which blocks our hosts since 25.11.2026.
//
// The action ids are build hashes that change when the site redeploys. When a
// cached id stops answering in the expected shape, the client reads the page's
// scripts, tries every server reference it finds, and keeps the one whose
// answer passes that action's check.
//
// Same client as svrz_rc (server/svrzGameCenter.ts) and wiedisync
// (kscw-endpoints/src/game-center.js), live there since 27.11.2026.

export const GAME_CENTER_BASE = process.env.SV_GAME_CENTER_BASE || 'https://www.svrz.ch'
const TIMEOUT_MS = Number(process.env.SV_GAME_CENTER_TIMEOUT_MS || 60_000)
const HEADERS = { 'User-Agent': 'openvolley-gamecenter/1.0', 'Accept-Language': 'de-CH,de;q=0.9' }

/** What each action takes and how to tell its answer from another action's. */
const ACTIONS = {
  // ["?region=SVRZ&includeCup=1&dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD"] → [game]
  games: {
    id: process.env.SV_GC_GAMES_ACTION || '4f4a04331e8b7f7726ca7b74caf8b2e1358570d4',
    ok: (v) => Array.isArray(v) && v.every((g) => g && typeof g === 'object' && 'gameId' in g),
    probeOk: (v) => Array.isArray(v) && v.length > 0 && 'gameId' in v[0],
  },
  // [groupId] → [{ rank, teamId, teamCaption, games, points, wins, …, clubId }]
  standings: {
    id: process.env.SV_GC_STANDINGS_ACTION || '20ff53f8a207f3e1c3b116d33848242a02070dea',
    ok: (v) => Array.isArray(v) && v.every((r) => r && typeof r === 'object' && 'rank' in r),
    probeOk: (v) => Array.isArray(v) && v.length > 0 && 'rank' in v[0] && 'teamId' in v[0],
  },
}

/** The value on line `1:` of a flight answer, or undefined. */
export function flightValue(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('1:'))
  if (!line) return undefined
  try { return JSON.parse(line.slice(2)); } catch { return undefined; }
}

async function post(id, arg, fetchImpl) {
  const res = await fetchImpl(`${GAME_CENTER_BASE}/game-center`, {
    method: 'POST',
    headers: { ...HEADERS, 'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([arg]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return undefined
  // UTF-8 explicitly: the answer names no charset, and "Rämi" must not become "RÃ¤mi".
  return flightValue(Buffer.from(await res.arrayBuffer()).toString('utf8'))
}

async function discover(kind, probeArg, fetchImpl) {
  const page = await (await fetchImpl(`${GAME_CENTER_BASE}/game-center`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })).text()
  const scripts = [...new Set(page.match(/\/_next\/static\/chunks\/[^"'\s]+\.js/g) ?? [])]
  const ids = new Set()
  for (const src of scripts) {
    const js = await (await fetchImpl(`${GAME_CENTER_BASE}${src}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })).text()
    for (const m of js.matchAll(/\.\$\)\("([0-9a-f]{40})"\)/g)) ids.add(m[1])
  }
  for (const id of ids) {
    const v = await post(id, probeArg, fetchImpl).catch(() => undefined)
    if (ACTIONS[kind].probeOk(v)) return id
  }
  throw new Error(`Game Center: none of ${ids.size} server actions answers like "${kind}" — has the site changed?`)
}

/** One call of `kind`, re-finding the action once if the cached id fails.
 *  `probeArg` must be an argument that surely has data (used only to find it). */
async function act(kind, arg, probeArg, fetchImpl) {
  let v = await post(ACTIONS[kind].id, arg, fetchImpl)
  if (!ACTIONS[kind].ok(v)) {
    ACTIONS[kind].id = await discover(kind, probeArg, fetchImpl)
    v = await post(ACTIONS[kind].id, arg, fetchImpl)
  }
  if (!ACTIONS[kind].ok(v)) throw new Error(`Game Center "${kind}" did not answer for ${JSON.stringify(arg)}`)
  return v
}

/** [dateStart, dateEnd) pairs of at most `days` days covering from..to
 *  (YYYY-MM-DD, inclusive). dateEnd is exclusive at the Game Center. */
export function dateChunks(from, to, days = 31) {
  const day = 86_400_000
  const end = Date.parse(`${to}T00:00:00Z`) + day
  const out = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t < end; t += days * day) {
    out.push([new Date(t).toISOString().slice(0, 10), new Date(Math.min(t + days * day, end)).toISOString().slice(0, 10)])
  }
  return out
}

/**
 * Every game in [from, to] (YYYY-MM-DD, inclusive) for each scope
 * ({ region: 'SVRZ' | 'SV' | 'SVRA' | …, keep?: (game) => boolean }), one game
 * per gameId. Sequential, a month per call. Throws if any call fails, so a
 * partial read is never taken for the whole schedule.
 */
export async function fetchGames(scopes, from, to, fetchImpl = fetch) {
  const byId = new Map()
  const probe = `?region=${scopes[0].region}&includeCup=1&dateStart=${from}&dateEnd=${dateChunks(from, to, 100_000)[0][1]}`
  for (const { region, keep = () => true } of scopes) {
    for (const [start, end] of dateChunks(from, to)) {
      const games = await act('games', `?region=${region}&includeCup=1&dateStart=${start}&dateEnd=${end}`, probe, fetchImpl)
      for (const g of games) if (keep(g)) byId.set(String(g.gameId), g)
    }
  }
  return [...byId.values()]
}

/** The standings of one group (the `group.groupId` a game carries). */
export async function fetchStandings(groupId, fetchImpl = fetch) {
  return act('standings', Number(groupId), Number(groupId), fetchImpl)
}

/** Test seam. */
export function __setActionId(kind, id) { ACTIONS[kind].id = id; }
