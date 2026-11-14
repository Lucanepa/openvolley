/**
 * POST /api/match/send-info for a match. The server builds the mail from the
 * stored match, so for a match just created it answers 404 until the sync
 * has uploaded the insert: a 404 is retried after each of delaysMs.
 * Resolves to the server's JSON ({ success, error }); never throws.
 */
export async function sendMatchInfoMail({ url, headers, externalId, delaysMs = [5000, 15000, 45000], fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const waits = [0, ...delaysMs]
  let last = { success: false, error: 'Match not found' }
  for (const wait of waits) {
    if (wait) await sleep(wait)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ externalId })
      })
      last = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
      if (res.status !== 404) return last
    } catch (err) {
      return { success: false, error: err?.message || 'Network error' }
    }
  }
  return last
}
