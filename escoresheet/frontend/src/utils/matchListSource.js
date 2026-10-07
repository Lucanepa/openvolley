import { mergePickerMatches } from './pickerMatches'

/**
 * How long a cloud-first list waits for the relay once the cloud has
 * answered with matches: a relay that never answers must not hold up the
 * cloud's list.
 */
export const RELAY_GRACE_MS = 3000

/**
 * Which servers list the matches a referee / bench tablet can join.
 *
 * On the web the cloud and the relay are asked together and their lists
 * merged by match id (mergePickerMatches: the relay's row wins, it is the
 * scorer's live copy): a hall's relay matches show even when the cloud lists
 * others, and a stale cloud row no longer hides them. On a page served by a
 * local relay (desktop app, Pi, the venue tablets loading from
 * http://<laptop-IP>:5173) the relay is right here and carries every match
 * of the hall, while the cloud may hang (hall Wi-Fi without uplink, a DNS
 * lookup that never answers): ask the relay first, so the list appears at
 * once, and the cloud only when the relay has nothing.
 *
 * @param {object} opts
 * @param {() => Promise<{success:boolean, matches?:Array}>} opts.listCloud
 * @param {() => Promise<{success:boolean, matches?:Array}>} opts.listRelay
 * @param {boolean} [opts.relayFirst]
 * @param {boolean} [opts.useCloud=true] false: relay only (WebSocket mode)
 * @param {number} [opts.relayGraceMs=RELAY_GRACE_MS]
 * @returns {Promise<{ result: {success:boolean, matches?:Array}, source: 'supabase'|'websocket', cloud: object|null }>}
 *   `source`: 'websocket' when the list is the relay's alone, else
 *   'supabase'. Merged rows say each where they came from (`listSource`).
 *   `cloud` is the cloud's own answer when it was asked (null otherwise).
 */
export async function loadMatchList({ listCloud, listRelay, relayFirst = false, useCloud = true, relayGraceMs = RELAY_GRACE_MS }) {
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

  // Both at once; the relay's answer is awaited in full only when the cloud
  // has no matches (then it is the list)
  const relayAnswer = safe(listRelay)
  const cloud = await safe(listCloud)
  if (hasMatches(cloud)) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ success: false, matches: [], error: 'relay timeout' }), relayGraceMs)
    })
    const relay = await Promise.race([relayAnswer, timeout])
    clearTimeout(timer)
    const relayRows = hasMatches(relay) ? relay.matches : []
    return { result: { ...cloud, matches: mergePickerMatches(cloud.matches, relayRows) }, source: 'supabase', cloud }
  }
  const relay = await relayAnswer
  if (hasMatches(relay)) return { result: relay, source: 'websocket', cloud }
  if (cloud.success) return { result: cloud, source: 'supabase', cloud }
  return { result: relay, source: 'websocket', cloud }
}
