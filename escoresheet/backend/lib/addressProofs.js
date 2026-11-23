/**
 * What an address bucket proved recently (audit 2611 PERM-03, SEC-08): the
 * match tokens the cloud issued or accepted for a match from that bucket
 * (validate-connection-pin, an X-OV-Match-Token read on /api/db, a PIN or a
 * token the relay accepted on a role socket for a room the database proved).
 *
 * The apps in the halls (OpenVolley 26.11.x and 3.x) send no match token on
 * their live sockets. Their referee and bench tablets check the PIN from the
 * same device before they follow the match there, so "this bucket proved
 * this match in the last hours" stands in for the token they do not send:
 * the live hub gives such a token-less channel a live state's private
 * columns, and counts such a socket among the match devices it keeps slots
 * for. An outside scraper proves no match.
 *
 * A proof is the token payload (lib/matchAccess.js: u = matches.id, r = the
 * role, s = the stored PIN's fingerprint): the caller checks it against the
 * match row again (stillGrantsRow) before it grants anything, so a switched
 * off connection or a changed PIN ends it as it ends the token.
 *
 * Bounded: at most `maxBuckets` buckets (the least recently proved go), per
 * bucket `maxPerBucket` matches (its oldest proof goes), per match
 * `maxBucketsPerMatch` buckets (the first ones keep it: one PIN cannot mark
 * every /64 of a customer's network).
 */

const HOUR = 60 * 60 * 1000

/**
 * @param {{ ttlMs?: number, maxBuckets?: number, maxPerBucket?: number, maxBucketsPerMatch?: number, now?: () => number }} [options]
 */
export function createAddressProofs ({ ttlMs = 12 * HOUR, maxBuckets = 20000, maxPerBucket = 16, maxBucketsPerMatch = 8, now = Date.now } = {}) {
  /** bucket -> Map(matchUuid -> { at, payload }) (least recently proved bucket first) */
  const byBucket = new Map()
  /** matchUuid -> Set of buckets that proved it */
  const byMatch = new Map()

  const live = (e, t) => !!e && t - e.at < ttlMs

  function forget (bucket, matchUuid) {
    const set = byMatch.get(matchUuid)
    if (!set) return
    set.delete(bucket)
    if (set.size === 0) byMatch.delete(matchUuid)
  }

  function dropBucket (bucket) {
    const own = byBucket.get(bucket)
    if (!own) return
    for (const matchUuid of own.keys()) forget(bucket, matchUuid)
    byBucket.delete(bucket)
  }

  /** The proofs of `bucket` still in time (expired ones go). */
  function entriesOf (bucket, t) {
    const own = byBucket.get(bucket)
    if (!own) return null
    for (const [matchUuid, e] of own) {
      if (!live(e, t)) {
        own.delete(matchUuid)
        forget(bucket, matchUuid)
      }
    }
    if (own.size === 0) {
      byBucket.delete(bucket)
      return null
    }
    return own
  }

  /** Room for one more bucket of `matchUuid`: false when its first buckets (still in time) hold it. */
  function matchHasRoom (matchUuid, bucket, t) {
    const set = byMatch.get(matchUuid)
    if (!set || set.has(bucket)) return true
    for (const b of [...set]) {
      if (!live(byBucket.get(b)?.get(matchUuid), t)) {
        set.delete(b)
        byBucket.get(b)?.delete(matchUuid)
      }
    }
    return set.size < maxBucketsPerMatch
  }

  /**
   * `bucket` proved the match of `payload` (a verified match token payload
   * with u = matches.id) just now. Returns whether it was recorded.
   */
  function note (bucket, payload) {
    if (typeof bucket !== 'string' || !bucket) return false
    const matchUuid = payload && typeof payload.u === 'string' && payload.u ? payload.u : null
    if (!matchUuid) return false
    const t = now()
    if (!matchHasRoom(matchUuid, bucket, t)) return false
    let own = byBucket.get(bucket)
    if (own) byBucket.delete(bucket) // re-added as the most recently proved
    else {
      own = new Map()
      while (byBucket.size >= maxBuckets) dropBucket(byBucket.keys().next().value)
    }
    byBucket.set(bucket, own)
    own.delete(matchUuid)
    while (own.size >= maxPerBucket) {
      const oldest = own.keys().next().value
      own.delete(oldest)
      forget(bucket, oldest)
    }
    own.set(matchUuid, { at: t, payload: { ...payload } })
    let set = byMatch.get(matchUuid)
    if (!set) byMatch.set(matchUuid, (set = new Set()))
    set.add(bucket)
    return true
  }

  /** The payload `bucket` proved `matchUuid` with (in time), else null. */
  function proofOf (bucket, matchUuid) {
    if (typeof bucket !== 'string' || matchUuid == null) return null
    const own = entriesOf(bucket, now())
    return own?.get(String(matchUuid))?.payload ?? null
  }

  /** Did `bucket` prove any match (in time)? */
  function provedAny (bucket) {
    if (typeof bucket !== 'string') return false
    return !!entriesOf(bucket, now())
  }

  return {
    note,
    proofOf,
    provedAny,
    stats: () => ({ buckets: byBucket.size, matches: byMatch.size })
  }
}
