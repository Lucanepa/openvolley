/**
 * The phone's signing page (public/sign/, docs/qr-signing-spec.md 6, 8.5),
 * evaluated in jsdom with a fake fetch: the token leaves the address bar for
 * sessionStorage (and survives a reload), the language, the context as text,
 * every state, Done only with enough ink, point thinning, the point cap,
 * strokes kept across a resize and after a failed send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'sign')
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8')
const JS = readFileSync(join(DIR, 'sign.js'), 'utf8')
const TOKEN = 'Tok_' + 'x'.repeat(39)
const CONTEXT = { home: 'VBC Wiedikon', away: 'Volley 05', matchNo: '4711', when: '12.10.2026 20:15', teamSide: 'home', teamLabel: 'A', name: '#7 Lea Muster' }

let calls
let answers
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const flush = async () => { for (let i = 0; i < 5; i++) await sleep(0) }
const $ = (id) => document.getElementById(id)
const page = () => window.__ovSignPage

function setLanguages(list) {
  Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => list })
}

/** Load the page at `url` with `answers` for /api/sign/open and /api/sign/submit. */
async function load(url = `/sign#k=${TOKEN}`, { width = 400 } = {}) {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(HTML)[1]
  window.history.replaceState(null, '', url)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  Object.defineProperty($('padwrap'), 'clientWidth', { configurable: true, get: () => window.__padWidth ?? width })
  window.__padWidth = width
  $('pad').getBoundingClientRect = () => ({ left: 0, top: 0, width: window.__padWidth, height: 220, right: window.__padWidth, bottom: 220 })
  // eslint-disable-next-line no-new-func
  new Function(JS)()
  await flush()
}

function pointer(type, x, y, id = 1) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { pointerId: id, clientX: x, clientY: y, button: 0 })
  $('pad').dispatchEvent(e)
}

/** A stroke from (x0, y) to (x1, y) in CSS px, `step` px apart. */
function drawLine(x0, x1, y, step = 2, id = 1) {
  pointer('pointerdown', x0, y, id)
  for (let x = x0 + step; x <= x1; x += step) pointer('pointermove', x, y, id)
  pointer('pointerup', x1, y, id)
}

beforeEach(() => {
  calls = []
  answers = {
    open: { status: 200, json: { ok: true, state: 'opened', slot: 'captain-a', context: CONTEXT, expiresAt: 1 } },
    submit: { status: 200, json: { ok: true } },
  }
  vi.stubGlobal('fetch', vi.fn(async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body), init })
    const a = answers[path.split('/').pop()]
    if (a instanceof Error) throw a
    return { status: a.status, json: async () => a.json }
  }))
  const ctx = new Proxy({}, { get: (_, k) => (k in ctx ? undefined : () => {}), set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  window.sessionStorage.clear()
  setLanguages(['en-GB'])
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.__ovSignPage
  delete window.__padWidth
})

describe('the phone signing page', () => {
  it('moves the token from the address bar to sessionStorage and opens the session', async () => {
    await load()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/sign')
    expect(window.sessionStorage.getItem('ov_sign_k')).toBe(TOKEN)
    expect(calls[0]).toMatchObject({ path: '/api/sign/open', body: { k: TOKEN } })
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(page().state).toBe('ready')
  })

  it('a reload keeps working from sessionStorage', async () => {
    window.sessionStorage.setItem('ov_sign_k', TOKEN)
    await load('/sign')
    expect(calls[0].body).toEqual({ k: TOKEN })
    expect(page().state).toBe('ready')
  })

  it('without a token, or a malformed one: "not valid", nothing sent', async () => {
    await load('/sign')
    expect(page().state).toBe('invalid')
    expect($('endText').textContent).toBe('This link is not valid.')
    expect(calls).toHaveLength(0)
    await load('/sign#k=short')
    expect(page().state).toBe('invalid')
  })

  it('shows the role and the match as text', async () => {
    answers.open.json.context = { ...CONTEXT, name: '<img src=x onerror=alert(1)>' }
    await load()
    expect($('title').textContent).toBe('Sign as captain of Team A')
    expect($('teams').textContent).toBe('VBC Wiedikon – Volley 05')
    expect($('meta').textContent).toBe('Match #4711 · 12.10.2026 20:15')
    expect($('name').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('#name img')).toBeNull()
  })

  it('officials and coaches', async () => {
    answers.open.json = { ok: true, state: 'opened', slot: 'ref1', context: { home: 'A', away: 'B' } }
    await load()
    expect($('title').textContent).toBe('Sign as 1st referee')
    answers.open.json = { ok: true, state: 'opened', slot: 'coach-away', context: { home: 'A', away: 'Volley 05', teamSide: 'away' } }
    await load()
    expect($('title').textContent).toBe('Sign as coach of Volley 05')
  })

  it('speaks the phone\'s language: de-CH, de-AT -> de, fr, it, en; else the scorer\'s', async () => {
    const cases = [[['de-CH', 'de'], 'de-CH', 'Underschriibe als Captain vo Team A'], [['de-AT'], 'de', 'Unterschreiben als Captain von Team A'],
      [['fr-CH'], 'fr', 'Signer comme capitaine de l’équipe A'], [['it'], 'it', 'Firma come capitano di squadra A'], [['es', 'en-US'], 'en', 'Sign as captain of Team A']]
    for (const [langs, want, title] of cases) {
      setLanguages(langs)
      await load()
      expect(page().lang).toBe(want)
      expect(document.documentElement.lang).toBe(want)
      expect($('title').textContent).toBe(title)
    }
    setLanguages(['es'])
    answers.open.json.context = { ...CONTEXT, lang: 'fr' }
    await load()
    expect(page().lang).toBe('fr')
    expect($('done').textContent).toBe('Terminé')
  })

  it('every end state says what happened and forgets the token', async () => {
    const cases = [
      [{ status: 410, json: { ok: false, code: 'OV_SIGN_EXPIRED' } }, 'expired', 'This link has expired. Ask for a new QR code.'],
      [{ status: 409, json: { ok: false, code: 'OV_SIGN_USED' } }, 'used', 'This link was already used.'],
      [{ status: 409, json: { ok: false, code: 'OV_SIGN_CANCELLED' } }, 'cancelled', 'Signing was cancelled on the scoring device.'],
      [{ status: 404, json: { ok: false, code: 'OV_SIGN_NOT_FOUND' } }, 'invalid', 'This link is not valid.'],
    ]
    for (const [answer, state, text] of cases) {
      answers.open = answer
      await load()
      expect(page().state).toBe(state)
      expect($('endText').textContent).toBe(text)
      expect($('end').hidden).toBe(false)
      expect(window.sessionStorage.getItem('ov_sign_k')).toBeNull()
    }
  })

  it('Done stays off until there is enough ink; taps do not count', async () => {
    await load()
    expect($('done').disabled).toBe(true)
    pointer('pointerdown', 50, 50); pointer('pointerup', 50, 50)
    pointer('pointerdown', 80, 60); pointer('pointerup', 80, 60)
    expect(page().strokes).toHaveLength(2)
    expect($('done').disabled).toBe(true)
    drawLine(10, 40, 100) // 30 px = 300 units at 0.1 px per unit
    expect($('done').disabled).toBe(false)
    $('clear').click()
    expect(page().strokes).toHaveLength(0)
    expect($('done').disabled).toBe(true)
    expect($('hint').hidden).toBe(false)
  })

  it('keeps points in pad units and drops those closer than 8 units', async () => {
    await load()
    expect(page().pad).toEqual({ w: 4000, h: 2200 }) // 400 px wide, 220 px tall in portrait
    drawLine(10, 20, 100, 0.5) // 0.5 px = 5 units apart: every other point
    const s = page().strokes[0]
    expect(s.slice(0, 2)).toEqual([100, 1000])
    expect(s.length / 2).toBe(11)
    for (const v of s) expect(Number.isInteger(v)).toBe(true)
  })

  it('stops at the point cap and says so', async () => {
    await load()
    for (let i = 0; i < 5; i++) drawLine(0, 398, 20 + i * 40, 1) // 5 x ~399 points
    for (let i = 0; i < 6; i++) drawLine(0, 398, 40 + i * 30, 1, i + 2)
    expect(page().points).toBeLessThanOrEqual(4000)
    expect($('status').textContent).toBe('The pad is full. Tap Done, or Clear to start again.')
    const before = page().strokes.length
    drawLine(0, 50, 200, 1, 99)
    expect(page().strokes.length).toBe(before)
    for (const s of page().strokes) expect(s.length).toBeLessThanOrEqual(2000)
  })

  it('a second finger is ignored', async () => {
    await load()
    pointer('pointerdown', 10, 10, 1)
    pointer('pointerdown', 200, 200, 2)
    pointer('pointermove', 30, 10, 1)
    pointer('pointermove', 250, 200, 2)
    pointer('pointerup', 30, 10, 1)
    expect(page().strokes).toHaveLength(1)
  })

  it('a resize or rotation redraws the same strokes in the same pad units', async () => {
    await load()
    drawLine(10, 60, 100)
    const before = JSON.stringify(page().strokes)
    window.__padWidth = 700
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    window.dispatchEvent(new Event('resize'))
    expect(JSON.stringify(page().strokes)).toBe(before)
    expect(page().pad.h).toBe(2200)
  })

  it('a rotation before the first stroke gives the pad the new shape (no dead margins)', async () => {
    await load()
    expect(page().pad.h).toBe(2200)
    window.__padWidth = 700
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    window.dispatchEvent(new Event('resize'))
    // Landscape: 0.33 x 700 = 231 px tall, so 4000 x 1320 units fill the canvas
    expect(page().pad.h).toBe(1320)
    drawLine(10, 60, 100)
    window.__padWidth = 400
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    window.dispatchEvent(new Event('resize'))
    expect(page().pad.h).toBe(1320)
  })

  it('a Done whose answer was lost, then "already used": the signature did arrive', async () => {
    await load()
    drawLine(10, 60, 100)
    answers.submit = new TypeError('Failed to fetch')
    $('done').click()
    await flush()
    expect(page().state).toBe('failed')
    answers.submit = { status: 409, json: { ok: false, code: 'OV_SIGN_USED' } }
    $('done').click()
    await flush()
    expect(page().state).toBe('done')
    expect($('endText').textContent).toBe('Signature sent. You can close this page.')
  })

  it('"already used" after a refused Done (nothing arrived) stays "used"', async () => {
    await load()
    drawLine(10, 60, 100)
    answers.submit = { status: 429, json: { ok: false, code: 'OV_SIGN_RATE_LIMITED' } }
    $('done').click()
    await flush()
    expect(page().state).toBe('failed')
    answers.submit = { status: 409, json: { ok: false, code: 'OV_SIGN_USED' } }
    $('done').click()
    await flush()
    expect(page().state).toBe('used')
  })

  it('an end state is announced by the live region, the card is for the eyes', async () => {
    await load()
    drawLine(10, 60, 100)
    $('done').click()
    await flush()
    expect($('status').getAttribute('aria-live')).toBe('polite')
    expect($('status').textContent).toBe('Signature sent. You can close this page.')
    expect($('status').className).toBe('status sr')
    expect($('end').getAttribute('aria-hidden')).toBe('true')
  })

  it('Done sends the strokes, never an image, and ends with "sent"', async () => {
    await load()
    drawLine(10, 60, 100)
    $('done').click()
    await flush()
    const submit = calls.find((c) => c.path === '/api/sign/submit')
    expect(submit.body).toEqual({ k: TOKEN, pad: { w: 4000, h: 2200 }, strokes: page().strokes })
    expect(JSON.stringify(submit.body)).not.toMatch(/data:image/)
    expect(page().state).toBe('done')
    expect($('endText').textContent).toBe('Signature sent. You can close this page.')
    expect(window.sessionStorage.getItem('ov_sign_k')).toBeNull()
  })

  it('a failed send keeps the strokes and Done works again', async () => {
    await load()
    drawLine(10, 60, 100)
    answers.submit = new TypeError('Failed to fetch')
    $('done').click()
    await flush()
    expect(page().state).toBe('failed')
    expect($('status').textContent).toBe('Couldn’t send. Check the connection and tap Done again.')
    expect(page().strokes).toHaveLength(1)
    expect($('done').disabled).toBe(false)
    answers.submit = { status: 200, json: { ok: true } }
    $('done').click()
    await flush()
    expect(page().state).toBe('done')
  })

  it('a link used up meanwhile ends on submit, too', async () => {
    await load()
    drawLine(10, 60, 100)
    answers.submit = { status: 409, json: { ok: false, code: 'OV_SIGN_CANCELLED' } }
    $('done').click()
    await flush()
    expect(page().state).toBe('cancelled')
  })
})

describe('the phone page files', () => {
  it('no inline script or style, scripts and styles from the page\'s own origin only (CSP script-src \'self\')', () => {
    expect(HTML).not.toMatch(/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)/)
    expect(HTML).not.toMatch(/\son\w+=/)
    expect(HTML).not.toMatch(/style=/)
    expect(HTML).toContain('<script src="/sign/sign.js" defer></script>')
    expect(HTML).toContain('<link rel="stylesheet" href="/sign/sign.css">')
    expect(HTML + JS).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    const code = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/localStorage|document\.cookie|innerHTML/)
  })

  it('stays small', () => {
    const total = HTML.length + JS.length + readFileSync(join(DIR, 'sign.css'), 'utf8').length
    expect(total).toBeLessThan(25 * 1024)
  })
})
