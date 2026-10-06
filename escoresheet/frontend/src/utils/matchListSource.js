/**
 * Which server lists the matches a referee / bench tablet can join.
 *
 * On the web the cloud is authoritative and the relay is the fallback. On a
 * page served by a local relay (desktop app, Pi, the venue tablets loading
 * from http://<laptop-IP>:5173) the relay is right here and carries every
 * match of the hall, while the cloud may hang (hall Wi-Fi without uplink, a
 * DNS lookup that never answers): ask the relay first, so the list appears
 * at once, and the cloud only when the relay has nothing.
 *
 * @param {object} opts
 * @param {() => Promise<{success:boolean, matches?:Array}>} opts.listCloud
 * @param {() => Promise<{success:boolean, matches?:Array}>} opts.listRelay
 * @param {boolean} [opts.relayFirst]
 * @param {boolean} [opts.useCloud=true] false: relay only (WebSocket mode)
 * @returns {Promise<{ result: {success:boolean, matches?:Array}, source: 'supabase'|'websocket', cloud: object|null }>}
 *   `cloud` is the cloud's own answer when it was asked (null otherwise).
 */
export async function loadMatchList({ listCloud, listRelay, relayFirst = false, useCloud = true }) {
  const hasMatches = (r) => !!(r && r.success && Array.isArray(r.matches) && r.matches.length > 0)
  const safe = async (fn) => {
    try {
      return (await fn()) || { success: false, matches: [] }
    } catch (err) {
      return { success: false, matches: [], error: err?.message }
    }
  }

  if (!useCloud) {
    return { result: await safe(listRelay), source: 'websocket', cloud: null }
  }

  if (relayFirst) {
    const relay = await safe(listRelay)
    if (hasMatches(relay)) return { result: relay, source: 'websocket', cloud: null }
    const cloud = await safe(listCloud)
    if (cloud.success) return { result: cloud, source: 'supabase', cloud }
    return { result: relay, source: 'websocket', cloud }
  }

  const cloud = await safe(listCloud)
  if (hasMatches(cloud)) return { result: cloud, source: 'supabase', cloud }
  const relay = await safe(listRelay)
  if (hasMatches(relay)) return { result: relay, source: 'websocket', cloud }
  if (cloud.success) return { result: cloud, source: 'supabase', cloud }
  return { result: relay, source: 'websocket', cloud }
}
