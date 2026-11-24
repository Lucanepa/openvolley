/**
 * Pair a phone, the scoring device's side of the protocol
 * (docs/phone-keyboard-spec.md): start a pairing, long-poll it, report the
 * focused field, unpair. Every call resolves to a result and never throws:
 *   { ok: true, ...body }  or  { ok: false, status, code, network? }
 *
 * `handle` = { transport, apiBase, phoneBase, token, code, watch, joinBy, endsAt, startedAt }.
 * The token goes only into the QR link (in the URL fragment, never sent to a
 * server by the browser) and the code only onto this screen; the watch
 * secret stays in this tab's memory.
 */
import { authorizationHeader } from './apiClient'

const START_TIMEOUT_MS = 15000
// The relay holds a wait for 25 s at most
const WAIT_TIMEOUT_MS = 40000

function isLoopbackPage() {
  try {
    const h = String(window.location.hostname || '').replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch {
    return false
  }
}

async function postJson(url, body, { headers = {}, signal, timeoutMs, keepalive = false, fetchImpl = fetch } = {}) {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
      keepalive,
      cache: 'no-store',
    })
    let json = null
    try { json = await res.json() } catch { /* not JSON: an old relay without the feature */ }
    if (res.ok && json?.ok) return { ...json, ok: true, status: res.status }
    return { ok: false, status: res.status, code: json?.code || (res.status === 404 ? 'OV_PAIR_UNSUPPORTED' : 'OV_PAIR_HTTP') }
  } catch {
    return { ok: false, status: 0, code: signal?.aborted ? 'OV_PAIR_ABORTED' : 'OV_PAIR_NETWORK', network: !signal?.aborted }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * POST /api/pair/start: the /api/sign/start rule (cloud: the account's
 * session; LAN: the relay host itself, else the match's game PIN).
 * @returns {Promise<{ ok: true, handle: object } | { ok: false, status: number, code: string, network?: boolean }>}
 */
export async function startPhonePair({ transport, apiBase, phoneBase, matchKey = null, context, gamePin = null, fetchImpl }) {
  const headers = {}
  if (transport === 'cloud') Object.assign(headers, authorizationHeader())
  else if (gamePin && !isLoopbackPage()) headers['X-OV-Match-Pin'] = String(gamePin)
  const body = { context }
  if (matchKey) body.matchKey = String(matchKey)
  let r = await postJson(`${apiBase}/api/pair/start`, body, { headers, timeoutMs: START_TIMEOUT_MS, fetchImpl })
  // A loopback page the relay does not see as itself (a --local backend in Docker): once more with the PIN
  if (!r.ok && transport === 'lan' && r.code === 'OV_PAIR_FORBIDDEN' && gamePin && !headers['X-OV-Match-Pin']) {
    headers['X-OV-Match-Pin'] = String(gamePin)
    r = await postJson(`${apiBase}/api/pair/start`, body, { headers, timeoutMs: START_TIMEOUT_MS, fetchImpl })
  }
  if (!r.ok) return r
  return {
    ok: true,
    handle: {
      transport,
      apiBase,
      phoneBase,
      token: r.token,
      code: r.code,
      watch: r.watch,
      joinBy: r.joinBy,
      endsAt: r.endsAt,
      // countdowns run on this device's clock (the relay's may differ)
      startedAt: Date.now(),
    },
  }
}

/**
 * The link in the QR code: the token in the fragment only. /pair/ with the
 * slash: every relay serves the page there (the Vite dev server only there).
 */
export function phonePairUrl(handle) {
  return `${handle.phoneBase}/pair/#k=${handle.token}`
}

/** The page a phone opens to type the code instead. */
export function phonePairPageUrl(handle) {
  return `${handle.phoneBase}/pair/`
}

/** The short code as shown: ABCD-EFGH. */
export function displayCode(code) {
  const c = String(code || '')
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/** POST /api/pair/wait: at once on news, else after up to 25 s. */
export function waitPhonePair(handle, { knownState, after = 0, knownPhone } = {}, { signal, fetchImpl } = {}) {
  const body = { watch: handle.watch, after }
  if (knownState) body.knownState = knownState
  if (typeof knownPhone === 'boolean') body.knownPhone = knownPhone
  return postJson(`${handle.apiBase}/api/pair/wait`, body, { signal, timeoutMs: WAIT_TIMEOUT_MS, fetchImpl })
}

/** POST /api/pair/focus: the field the phone types into (null: none), and the last input applied. */
export function focusPhonePair(handle, field, applied, { fetchImpl } = {}) {
  return postJson(`${handle.apiBase}/api/pair/focus`, { watch: handle.watch, field, applied }, { timeoutMs: 10000, fetchImpl })
}

/** POST /api/pair/close: unpair. `keepalive` for pagehide. */
export function closePhonePair(handle, { keepalive = false, fetchImpl } = {}) {
  if (!handle?.watch) return Promise.resolve({ ok: true })
  return postJson(`${handle.apiBase}/api/pair/close`, { watch: handle.watch }, { keepalive, timeoutMs: 10000, fetchImpl })
}
