/**
 * Sign on phone, the scoring device's side of the protocol
 * (docs/qr-signing-spec.md 4.2, 5.1): start a session, long-poll its state,
 * close it. Every call resolves to a result and never throws:
 *   { ok: true, ...body }  or  { ok: false, status, code, network? }
 *
 * `handle` = { transport, apiBase, phoneBase, token, watch, expiresAt, ttlSeconds, startedAt }.
 * The token goes only into the link the phone opens (in the URL fragment,
 * never sent to a server by the browser); the watch secret stays here.
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
    return { ok: false, status: res.status, code: json?.code || (res.status === 404 ? 'OV_SIGN_UNSUPPORTED' : 'OV_SIGN_HTTP') }
  } catch (err) {
    return { ok: false, status: 0, code: signal?.aborted ? 'OV_SIGN_ABORTED' : 'OV_SIGN_NETWORK', network: !signal?.aborted }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * POST /api/sign/start. Cloud: with the account's session. LAN: the relay
 * host itself needs nothing; another device sends the match's game PIN.
 * @param {{ transport: 'cloud'|'lan', apiBase: string, phoneBase: string, slot: string,
 *   matchKey?: string|null, context: object, gamePin?: string|null, fetchImpl?: Function }} opts
 * @returns {Promise<{ ok: true, handle: object } | { ok: false, status: number, code: string, network?: boolean }>}
 */
export async function startPhoneSign({ transport, apiBase, phoneBase, slot, matchKey = null, context, gamePin = null, fetchImpl }) {
  const headers = {}
  if (transport === 'cloud') Object.assign(headers, authorizationHeader())
  else if (gamePin && !isLoopbackPage()) headers['X-OV-Match-Pin'] = String(gamePin)
  const body = { slot, context }
  if (matchKey) body.matchKey = String(matchKey)
  let r = await postJson(`${apiBase}/api/sign/start`, body, { headers, timeoutMs: START_TIMEOUT_MS, fetchImpl })
  // A loopback page whose relay does not see it as itself (a --local backend
  // in Docker sees the bridge address): once more, now proving the game PIN
  if (!r.ok && transport === 'lan' && r.code === 'OV_SIGN_FORBIDDEN' && gamePin && !headers['X-OV-Match-Pin']) {
    headers['X-OV-Match-Pin'] = String(gamePin)
    r = await postJson(`${apiBase}/api/sign/start`, body, { headers, timeoutMs: START_TIMEOUT_MS, fetchImpl })
  }
  if (!r.ok) return r
  return {
    ok: true,
    handle: {
      transport,
      apiBase,
      phoneBase,
      token: r.token,
      watch: r.watch,
      expiresAt: r.expiresAt,
      ttlSeconds: r.ttlSeconds || 600,
      // The countdown runs on this device's clock (the relay's may differ)
      startedAt: Date.now(),
    },
  }
}

/** The link the phone opens: the token in the fragment only. */
export function phoneSignUrl(handle) {
  return `${handle.phoneBase}/sign#k=${handle.token}`
}

/**
 * POST /api/sign/wait: answers at once when the state is not `known`, else on
 * the next change, else after 25 s with the same state.
 * @returns {Promise<{ ok: true, state: string, pad?: object, strokes?: number[][] } | { ok: false, code: string, network?: boolean }>}
 */
export function waitPhoneSign(handle, known, { signal, fetchImpl } = {}) {
  const body = { watch: handle.watch }
  if (known) body.known = known
  return postJson(`${handle.apiBase}/api/sign/wait`, body, { signal, timeoutMs: WAIT_TIMEOUT_MS, fetchImpl })
}

/** POST /api/sign/close: the link stops working. `keepalive` for pagehide. */
export function closePhoneSign(handle, { keepalive = false, fetchImpl } = {}) {
  if (!handle?.watch) return Promise.resolve({ ok: true })
  return postJson(`${handle.apiBase}/api/sign/close`, { watch: handle.watch }, { keepalive, timeoutMs: 10000, fetchImpl })
}
