/**
 * Sign on phone over HTTP, from the relay host itself (loopback, so `start`
 * needs no PIN): one scenario for every relay runtime (server.js, Electron,
 * the Vite plugin, the Tauri binary, backend/server.js --local). Returns a
 * list of mismatches (empty = the runtime speaks the protocol of
 * docs/qr-signing-spec.md 4), so the frontend vitest and the backend node:test
 * suites can both use it.
 */

const CTX = { home: 'VBC Wiedikon', away: 'Volley 05', matchNo: '4711' }
const INK = { pad: { w: 4000, h: 2000 }, strokes: [[0, 1000, 300, 1000], [10, 1200, 600, 1300, 900, 1250]] }

async function post(base, endpoint, body, { headers = {}, raw = null, contentType = 'application/json' } = {}) {
  const res = await fetch(`${base}/api/sign/${endpoint}`, {
    method: 'POST',
    headers: { ...(contentType ? { 'Content-Type': contentType } : {}), ...headers },
    body: raw !== null ? raw : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

/**
 * @param {{ httpBase: string, startHeaders?: object, matchKey?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function signHttpScenario({ httpBase, startHeaders = {}, matchKey = 'scenario-match' }) {
  const failures = []
  const expect = (what, cond, detail = '') => { if (!cond) failures.push(`${what}${detail ? `: ${detail}` : ''}`) }
  const code = (r, status, c, what) => expect(what, r.status === status && (!c || r.json?.code === c), `${r.status} ${r.text.slice(0, 200)}`)

  // Malformed requests
  code(await post(httpBase, 'start', { slot: 'ref1', context: CTX }, { contentType: 'text/plain', headers: startHeaders }), 400, 'OV_SIGN_BAD_REQUEST', 'start without a JSON content type')
  code(await post(httpBase, 'start', null, { raw: '{"slot":', headers: startHeaders }), 400, 'OV_SIGN_BAD_REQUEST', 'start with broken JSON')
  code(await post(httpBase, 'start', { slot: 'ref1', context: { ...CTX, name: 'x'.repeat(5000) } }, { headers: startHeaders }), 413, 'OV_SIGN_TOO_LARGE', 'start over 4 KB')
  code(await post(httpBase, 'start', { slot: 'nope', context: CTX }, { headers: startHeaders }), 400, 'OV_SIGN_SLOT', 'start with an unknown slot')

  // The flow
  const started = await post(httpBase, 'start', { slot: 'captain-a', matchKey, context: { ...CTX, home: 'VBC ‮Wiedikon' } }, { headers: startHeaders })
  code(started, 201, null, 'start')
  if (started.status !== 201) return failures
  expect('start answer', /^[A-Za-z0-9_-]{43}$/.test(started.json.token) && /^[A-Za-z0-9_-]{43}$/.test(started.json.watch) && started.json.path === '/sign' && started.json.ttlSeconds === 600, started.text)
  expect('Cache-Control no-store', /no-store/.test(started.headers.get('cache-control') || ''), started.headers.get('cache-control'))
  const { token, watch } = started.json

  const first = await post(httpBase, 'wait', { watch })
  expect('first wait answers at once with pending', first.status === 200 && first.json?.state === 'pending', first.text)

  const t0 = Date.now()
  const held = post(httpBase, 'wait', { watch, known: 'pending' })
  await new Promise((r) => setTimeout(r, 300))
  const opened = await post(httpBase, 'open', { k: token })
  expect('open', opened.status === 200 && opened.json?.state === 'opened' && opened.json?.slot === 'captain-a', opened.text)
  expect('open: sanitised context', opened.json?.context?.home === 'VBC Wiedikon' && opened.json?.context?.matchNo === '4711', JSON.stringify(opened.json?.context))
  const woke = await held
  expect('held wait wakes on open', woke.status === 200 && woke.json?.state === 'opened' && Date.now() - t0 < 5000, woke.text)

  const big = JSON.stringify({ k: token, pad: INK.pad, strokes: [Array.from({ length: 40000 }, (_, i) => i % 2)] })
  code(await post(httpBase, 'submit', null, { raw: big }), 413, 'OV_SIGN_TOO_LARGE', 'submit over 64 KB')
  code(await post(httpBase, 'submit', { k: token, pad: INK.pad, strokes: [[1, 1]] }), 400, 'OV_SIGN_INK_INVALID', 'submit without ink')
  code(await post(httpBase, 'submit', { k: token, ...INK }), 200, null, 'submit')
  code(await post(httpBase, 'submit', { k: token, ...INK }), 409, 'OV_SIGN_USED', 'second submit')
  code(await post(httpBase, 'open', { k: token }), 409, 'OV_SIGN_USED', 'open after submit')

  const signed = await post(httpBase, 'wait', { watch, known: 'opened' })
  expect('wait returns the strokes', signed.status === 200 && signed.json?.state === 'signed' &&
    JSON.stringify(signed.json?.strokes) === JSON.stringify(INK.strokes) && JSON.stringify(signed.json?.pad) === JSON.stringify(INK.pad), signed.text)

  code(await post(httpBase, 'close', { watch }), 200, null, 'close')
  const closed = await post(httpBase, 'wait', { watch, known: 'signed' })
  expect('wait after close', closed.status === 200 && closed.json?.state === 'closed' && !('strokes' in (closed.json || {})), closed.text)
  code(await post(httpBase, 'open', { k: 'A'.repeat(43) }), 404, 'OV_SIGN_NOT_FOUND', 'unknown token')

  // A second session cancelled before the phone opens it
  const second = await post(httpBase, 'start', { slot: 'ref1', context: CTX }, { headers: startHeaders })
  code(second, 201, null, 'second start')
  if (second.status === 201) {
    const pending = post(httpBase, 'wait', { watch: second.json.watch, known: 'pending' })
    await new Promise((r) => setTimeout(r, 200))
    code(await post(httpBase, 'close', { watch: second.json.watch }), 200, null, 'close the second')
    const r = await pending
    expect('close wakes the held wait', r.status === 200 && r.json?.state === 'closed', r.text)
    code(await post(httpBase, 'open', { k: second.json.token }), 409, 'OV_SIGN_CANCELLED', 'open after close')
  }
  return failures
}

/**
 * The phone page at /sign with its headers (spec 4.7). `expectBody` is a
 * string the page must contain.
 * @returns {Promise<string[]>}
 */
export async function signPageCheck({ httpBase, expectBody = 'sign.js' }) {
  const failures = []
  for (const path of ['/sign', '/sign/', '/sign/sign.js', '/sign/sign.css']) {
    const res = await fetch(httpBase + path)
    const text = await res.text()
    const csp = res.headers.get('content-security-policy') || ''
    if (res.status !== 200) failures.push(`${path}: ${res.status}`)
    if (!/default-src 'none'/.test(csp) || !/script-src 'self'/.test(csp) || !/frame-ancestors 'none'/.test(csp)) failures.push(`${path}: CSP ${csp}`)
    if (res.headers.get('referrer-policy') !== 'no-referrer') failures.push(`${path}: Referrer-Policy ${res.headers.get('referrer-policy')}`)
    if (!/no-cache/.test(res.headers.get('cache-control') || '')) failures.push(`${path}: Cache-Control ${res.headers.get('cache-control')}`)
    if (res.headers.get('x-content-type-options') !== 'nosniff') failures.push(`${path}: nosniff missing`)
    if (path.startsWith('/sign/sign.') && /<html/i.test(text)) failures.push(`${path}: got HTML (SPA fallback?)`)
    if ((path === '/sign' || path === '/sign/') && !text.includes(expectBody)) failures.push(`${path}: not the phone page`)
  }
  return failures
}
