/**
 * Pair a phone over HTTP (docs/phone-keyboard-spec.md): one scenario for every
 * relay runtime (server.js, the Vite plugin, the Tauri binary,
 * backend/server.js --local and the cloud backend). The scoring device starts
 * (with `startHeaders` / `startBody` where the runtime needs them), a phone
 * joins with the QR token, the device reports a focused field, the phone types
 * and the device's held wait wakes with the text, then the device unpairs.
 * Returns a list of mismatches (empty = the runtime speaks the protocol).
 */

const CTX = { home: 'VBC Musterdorf', away: 'Volley 05', matchNo: '4711' }

async function post(base, endpoint, body, { headers = {}, raw = null, contentType = 'application/json' } = {}) {
  const res = await fetch(`${base}/api/pair/${endpoint}`, {
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
 * @param {{ httpBase: string, startHeaders?: object, matchKey?: string, context?: object, expectContext?: object }} opts
 * @returns {Promise<string[]>}
 */
export async function pairHttpScenario({ httpBase, startHeaders = {}, matchKey = 'scenario-match', context = CTX, expectContext = null }) {
  const failures = []
  const expect = (what, cond, detail = '') => { if (!cond) failures.push(`${what}${detail ? `: ${detail}` : ''}`) }
  const code = (r, status, c, what) => expect(what, r.status === status && (!c || r.json?.code === c), `${r.status} ${r.text.slice(0, 200)}`)

  code(await post(httpBase, 'start', { context }, { contentType: 'text/plain', headers: startHeaders }), 400, 'OV_PAIR_BAD_REQUEST', 'start without a JSON content type')
  code(await post(httpBase, 'start', null, { raw: '{"context":', headers: startHeaders }), 400, 'OV_PAIR_BAD_REQUEST', 'start with broken JSON')
  code(await post(httpBase, 'start', { matchKey, context: { ...context, when: 'x'.repeat(5000) } }, { headers: startHeaders }), 413, 'OV_PAIR_TOO_LARGE', 'start over 4 KB')

  const started = await post(httpBase, 'start', { matchKey, context: { ...context, home: `${context.home}‮` } }, { headers: startHeaders })
  code(started, 201, null, 'start')
  if (started.status !== 201) return failures
  expect('start answer', /^[A-Za-z0-9_-]{43}$/.test(started.json.token) && /^[A-Za-z0-9_-]{43}$/.test(started.json.watch) &&
    /^[A-HJ-NP-Z2-9]{8}$/.test(started.json.code) && started.json.path === '/pair', started.text)
  expect('Cache-Control no-store', /no-store/.test(started.headers.get('cache-control') || ''), started.headers.get('cache-control'))
  const { token, watch } = started.json

  const first = await post(httpBase, 'wait', { watch })
  expect('first wait answers at once with pending', first.status === 200 && first.json?.state === 'pending' && first.json?.phone?.connected === false, first.text)

  // the device holds a wait; the phone joins with the QR token
  const t0 = Date.now()
  const held = post(httpBase, 'wait', { watch, knownState: 'pending', after: 0, knownPhone: false })
  await new Promise((r) => setTimeout(r, 300))
  const joined = await post(httpBase, 'join', { k: token })
  expect('join', joined.status === 200 && joined.json?.state === 'paired' && /^[A-Za-z0-9_-]{43}$/.test(joined.json?.phone || ''), joined.text)
  const want = expectContext || context
  expect('join: sanitised context', joined.json?.context?.home === want.home && joined.json?.context?.matchNo === want.matchNo, JSON.stringify(joined.json?.context))
  const woke = await held
  expect('held wait wakes on join', woke.status === 200 && woke.json?.state === 'paired' && woke.json?.phone?.connected === true && Date.now() - t0 < 5000, woke.text)
  code(await post(httpBase, 'join', { k: token }), 409, 'OV_PAIR_USED', 'a second phone')
  code(await post(httpBase, 'join', { code: started.json.code }), 409, 'OV_PAIR_USED', 'a second phone by code')
  const phone = joined.json?.phone
  if (!phone) return failures

  // the phone holds a poll; the device focuses the remarks
  const p0 = await post(httpBase, 'poll', { phone })
  expect('first poll: no field', p0.status === 200 && p0.json?.field === null && p0.json?.v === 0, p0.text)
  const heldPoll = post(httpBase, 'poll', { phone, known: 0 })
  await new Promise((r) => setTimeout(r, 200))
  const field = { id: 'ov-remarks', label: 'Remarks', kind: 'multiline', text: 'Actual game start: 20:31\n', maxLength: 8000 }
  code(await post(httpBase, 'focus', { watch, field }), 200, null, 'focus')
  const polled = await heldPoll
  expect('held poll wakes with the field', polled.status === 200 && polled.json?.v === 1 && polled.json?.field?.id === 'ov-remarks' && polled.json?.field?.text === field.text, polled.text)

  // the phone types; the device's held wait wakes with the text
  const heldWait = post(httpBase, 'wait', { watch, knownState: 'paired', after: 0, knownPhone: true })
  await new Promise((r) => setTimeout(r, 200))
  code(await post(httpBase, 'input', { phone, n: 1, field: 'ov-remarks', text: `${field.text}Ball changed\u0000 at 12:10` }), 200, null, 'input')
  const got = await heldWait
  const inp = got.json?.inputs?.[0]
  expect('held wait wakes with the input', got.status === 200 && inp?.text === `${field.text}Ball changed at 12:10` && inp?.n === 1 && inp?.field === 'ov-remarks', got.text)
  code(await post(httpBase, 'input', { phone, n: 2, field: 'other', text: 'x' }), 409, 'OV_PAIR_STALE', 'input for another field')
  const big = JSON.stringify({ phone, n: 3, field: 'ov-remarks', text: 'x'.repeat(70000) })
  code(await post(httpBase, 'input', null, { raw: big }), 413, 'OV_PAIR_TOO_LARGE', 'input over 64 KB')
  code(await post(httpBase, 'input', { phone, n: 3, field: 'ov-remarks', text: 'x'.repeat(8001) }), 400, 'OV_PAIR_TEXT_TOO_LONG', 'input over 8000 characters')
  code(await post(httpBase, 'input', { phone, n: 3, field: 'ov-remarks', action: 'next' }), 200, null, 'an action')

  // unpair: both sides told
  const lastPoll = post(httpBase, 'poll', { phone, known: 1 })
  await new Promise((r) => setTimeout(r, 200))
  code(await post(httpBase, 'close', { watch }), 200, null, 'close')
  const ended = await lastPoll
  expect('close answers the held poll', ended.status === 200 && ended.json?.state === 'closed', ended.text)
  code(await post(httpBase, 'input', { phone, n: 4, field: 'ov-remarks', text: 'late' }), 409, 'OV_PAIR_CANCELLED', 'input after close')
  const after = await post(httpBase, 'wait', { watch })
  expect('wait after close', after.status === 200 && after.json?.state === 'closed', after.text)
  code(await post(httpBase, 'join', { code: 'ZZZZ-ZZZZ' }), 404, 'OV_PAIR_NOT_FOUND', 'a wrong code')
  code(await post(httpBase, 'close', { watch }), 200, null, 'close again')
  return failures
}

/** The phone page at /pair with the /sign page's strict headers. */
export async function pairPageCheck({ httpBase, expectBody = 'pair.js' }) {
  const failures = []
  for (const path of ['/pair', '/pair/', '/pair/pair.js', '/pair/pair.css']) {
    const res = await fetch(httpBase + path)
    const text = await res.text()
    const csp = res.headers.get('content-security-policy') || ''
    if (res.status !== 200) failures.push(`${path}: ${res.status}`)
    if (!/default-src 'none'/.test(csp) || !/script-src 'self'/.test(csp) || !/connect-src 'self'/.test(csp) || !/frame-ancestors 'none'/.test(csp)) failures.push(`${path}: CSP ${csp}`)
    if (res.headers.get('referrer-policy') !== 'no-referrer') failures.push(`${path}: Referrer-Policy ${res.headers.get('referrer-policy')}`)
    if (!/no-cache/.test(res.headers.get('cache-control') || '')) failures.push(`${path}: Cache-Control ${res.headers.get('cache-control')}`)
    if (res.headers.get('x-content-type-options') !== 'nosniff') failures.push(`${path}: nosniff missing`)
    if (path.startsWith('/pair/pair.') && /<html/i.test(text)) failures.push(`${path}: got HTML (SPA fallback?)`)
    if ((path === '/pair' || path === '/pair/') && !text.includes(expectBody)) failures.push(`${path}: not the phone page`)
  }
  return failures
}
