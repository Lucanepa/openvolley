/**
 * The mails the server sends to the signed-in scorer's OWN confirmed account
 * address (never to an address typed in the app):
 *
 * - POST /api/match/send-info: the match information, no PIN.
 * - POST /api/match/send-pin: the game PIN (the PIN notice right after
 *   Create match). The server keeps the game PIN hashed, so the app sends
 *   the PIN it shows and the server mails it only when it matches the
 *   stored one.
 *
 * The server builds each mail from the stored match, so for a match just
 * created it answers 404 until the sync has uploaded the insert: a 404 is
 * retried after each of delaysMs. Never throws.
 */
async function postWithRetry({ url, headers, body, delaysMs, fetchImpl, sleep }) {
  const waits = [0, ...delaysMs]
  let last = { status: 404, data: { success: false, error: 'Match not found' } }
  for (const wait of waits) {
    if (wait) await sleep(wait)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
      })
      const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
      last = { status: res.status, data }
      if (res.status !== 404) return last
    } catch (err) {
      return { status: 0, data: { success: false, network: true, error: err?.message || 'Network error' } }
    }
  }
  return last
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Resolves to the server's JSON ({ success, error }). */
export async function sendMatchInfoMail({ url, headers, externalId, delaysMs = [5000, 15000, 45000], fetchImpl = fetch, sleep = realSleep }) {
  return (await postWithRetry({ url, headers, body: { externalId }, delaysMs, fetchImpl, sleep })).data
}

/**
 * The game PIN to the account's own address. The notice opens right after
 * Create match, so the insert may still be on its way: shorter retries than
 * the info mail (about 20 s in all), the scorer waits on the button.
 * Resolves to the server's JSON plus `status` (0: no answer, `network` true).
 */
export async function sendMatchPinMail({ url, headers, externalId, gamePin, delaysMs = [3000, 6000, 12000], fetchImpl = fetch, sleep = realSleep }) {
  const { status, data } = await postWithRetry({ url, headers, body: { externalId, gamePin: String(gamePin ?? '') }, delaysMs, fetchImpl, sleep })
  return { ...data, status }
}
