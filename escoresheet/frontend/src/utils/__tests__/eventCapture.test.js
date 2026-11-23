// The global interaction capture (utils/eventCapture) as the support
// diagnostics read it back: a sample session on a page shaped like the
// scoring screen (taps, a press without a tap, pointer moves, scrolling,
// typing into a text field and into a PIN field, a list of people, a link
// with a PIN), through the real logger and buildTimeline. GOLDEN is the
// timeline the capture gave before the performance pass (22.11, recorded on
// 1fa05852a): the lighter press / move / scroll / focus entries must not
// change a line of it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installGlobalEventCapture, uninstallGlobalEventCapture } from '../eventCapture'
import { initComprehensiveLogger, getRecentLogs, getBufferedLogs, shutdownLogger } from '../comprehensiveLogger'
import { buildTimeline } from '../diagnosticsReport'

const TZ = 'Europe/Zurich'
const T0 = Date.parse('2026-11-22T19:30:00Z')
let at = T0
const step = (ms) => vi.setSystemTime(at += ms)

const PAGE = `
  <div id="root" class="min-h-screen flex flex-col">
    <main class="overflow-y-auto flex-1" id="scroller">
      <div class="court grid grid-cols-2 gap-2" data-component="Scoreboard">
        <div class="team-panel rounded-xl p-4" id="home-panel">VBC Musterdorf 12 set 2 · Game PIN 771234 · captain 7 Anna Sample · libero 4 · bench 10 11 12 13 14 15 16 17 18 19 20</div>
        <button class="inline-flex px-4 py-2" type="button" id="point-home" data-action="point-home">Point</button>
        <button class="inline-flex" type="button" aria-label="Time-out home">T</button>
      </div>
      <form class="space-y-2" id="approval">
        <label>Approval PIN <input class="w-full" type="password" aria-label="Approval PIN"></label>
        <input class="w-full" type="text" name="remarks">
      </form>
      <ul data-sensitive><li><button class="row" type="button">Anna Sample 14.03.2012</button></li></ul>
      <a href="https://openvolley.app/r?pin=482913">Referee link</a>
    </main>
  </div>`

const $ = (sel) => document.querySelector(sel)
const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] })

// A finger tap as Android's WebView delivers it
function fingerTap(el) {
  fireEvent.touchStart(el, touch(200, 300))
  step(60)
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: 200, clientY: 300 }] })
  step(5)
  fireEvent.mouseDown(el, { clientX: 200, clientY: 300 })
  step(2)
  fireEvent.mouseUp(el, { clientX: 200, clientY: 300 })
  step(1)
  fireEvent.click(el, { clientX: 200, clientY: 300 })
}

function typeInto(el, text) {
  for (const ch of text) {
    step(170)
    fireEvent.keyDown(el, { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}` })
    el.value = (el.value || '') + ch
    fireEvent.input(el, { target: { value: el.value } })
    fireEvent.keyUp(el, { key: ch })
  }
}

// The sample session; returns the timeline the support diagnostics show
async function sampleSession() {
  document.body.innerHTML = PAGE
  step(1000)
  fingerTap($('#point-home'))
  // a press on the team panel, no tap (a long text under the finger)
  step(2500)
  fireEvent.touchStart($('#home-panel'), touch(120, 140))
  step(700)
  fireEvent.touchEnd($('#home-panel'), { touches: [], changedTouches: [{ clientX: 121, clientY: 141 }] })
  // a swipe over the court
  step(1500)
  for (let i = 0; i < 6; i++) {
    fireEvent.touchMove($('.court'), touch(100 + i * 20, 200))
    step(40)
  }
  // scrolling the page
  step(1200)
  for (let i = 0; i < 5; i++) {
    $('#scroller').scrollTop = i * 50
    fireEvent.scroll($('#scroller'))
    step(220)
  }
  // a remark: focus, typed, left
  step(2000)
  const remarks = $('input[name="remarks"]')
  fireEvent.focus(remarks)
  fingerTap(remarks)
  typeInto(remarks, 'Late')
  fireEvent.change(remarks, { target: { value: 'Late' } })
  step(400)
  fireEvent.blur(remarks)
  // the approval PIN: focus, typed, left
  step(3000)
  const pin = $('input[type="password"]')
  fireEvent.focus(pin)
  fingerTap(pin)
  typeInto(pin, '482913')
  step(300)
  fireEvent.blur(pin)
  // a player in a list of people, the referee link, the time-out (a mouse)
  step(4000)
  fingerTap($('ul[data-sensitive] button'))
  step(2000)
  fireEvent.click($('a'), { clientX: 30, clientY: 700 })
  step(2500)
  const timeout = $('[aria-label="Time-out home"]')
  fireEvent.mouseDown(timeout, { clientX: 500, clientY: 120 })
  step(90)
  fireEvent.mouseUp(timeout, { clientX: 500, clientY: 120 })
  fireEvent.click(timeout, { clientX: 500, clientY: 120 })
  step(1000)
  const now = at
  return buildTimeline({ interaction: await getRecentLogs({ from: T0, to: now }), now, timeZone: TZ }).lines
}

const GOLDEN = [
  '———— 2026-11-22 ————',
  '20:30:00.000  ════ PAGE LOADED (a new page load: start or reload) ════',
  '20:30:01.068  tap     "Point"                       Scoreboard',
  '20:30:03.568  touch   touched (no tap) ×2',
  '20:30:05.768  move    pointer moved ×2',
  '20:30:07.208  scroll  scrolled ×2',
  '20:30:10.376  tap     input[name=remarks]',
  '20:30:10.546  type    typed 4 keys into input[name=remarks] (now 4 characters; the text is not included)',
  '20:30:14.524  tap     a password or PIN field',
  '20:30:14.694  type    typed into a password or PIN field: not recorded',
  '20:30:19.912  tap     li > button.row',
  '20:30:21.912  tap     "Referee link"',
  '20:30:24.502  tap     "T"                           Scoreboard'
]

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  initComprehensiveLogger(null, null)
  installGlobalEventCapture()
})
afterAll(() => {
  uninstallGlobalEventCapture()
  shutdownLogger()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the support timeline of a captured session', () => {
  it('is the one the capture gave before the performance pass', async () => {
    const lines = await sampleSession()
    expect(lines).toEqual(GOLDEN)
    // the session reached every kind of line it is about
    expect(getBufferedLogs().filter(e => e.category === 'ui').map(e => e.type)).toEqual(expect.arrayContaining(['touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'touchmove', 'scroll', 'focus', 'blur', 'keydown', 'input', 'change']))
  })
})

describe('what a captured entry keeps (performance pass, 22.11)', () => {
  const LIGHT = ['touchstart', 'touchend', 'mousedown', 'mouseup', 'touchmove', 'scroll', 'focus', 'blur']
  const newest = (type) => getBufferedLogs().filter(e => e.category === 'ui' && e.type === type).at(-1)

  it('a press, move, scroll, focus or blur: tag, id and component, no text, path, classes or data', () => {
    document.body.innerHTML = PAGE
    const panel = $('#home-panel')
    fireEvent.touchStart(panel, touch(1, 2))
    fireEvent.touchEnd(panel, { touches: [], changedTouches: [{ clientX: 1, clientY: 2 }] })
    fireEvent.mouseDown(panel)
    fireEvent.mouseUp(panel)
    step(200)
    fireEvent.touchMove(panel, touch(3, 4))
    step(600)
    fireEvent.scroll($('#scroller'))
    fireEvent.focus($('input[name="remarks"]'))
    fireEvent.blur($('input[name="remarks"]'))
    for (const type of LIGHT) {
      const e = newest(type)
      expect(e, type).toBeTruthy()
      expect(Object.keys(e.target).sort(), type).toEqual(['ariaLabel', 'id', 'name', 'tagName', 'type'])
      expect(JSON.stringify(e.target), type).not.toMatch(/Musterdorf|771234|team-panel|court/)
    }
    expect(newest('touchstart').target).toMatchObject({ tagName: 'div', id: 'home-panel' })
    expect(newest('touchstart').component).toBe('Scoreboard')
    expect(newest('focus').target).toMatchObject({ tagName: 'input', name: 'remarks', type: 'text' })
    // the payload is as before (where the finger was)
    expect(newest('touchstart').payload).toMatchObject({ touches: 1, changedTouches: 1, clientX: 1, clientY: 2 })
  })

  it('a press on a PIN field is still one of a secret field', async () => {
    document.body.innerHTML = PAGE
    const { isSecretEntry } = await import('../comprehensiveLogger')
    const pin = $('input[type="password"]')
    fireEvent.touchStart(pin, touch(5, 5))
    fireEvent.focus(pin)
    expect(isSecretEntry(newest('touchstart'))).toBe(true)
    expect(isSecretEntry(newest('focus'))).toBe(true)
    // by its label too
    document.body.insertAdjacentHTML('beforeend', '<input id="ref-pin-field" type="text" aria-label="Referee PIN">')
    fireEvent.mouseDown($('#ref-pin-field'))
    expect(isSecretEntry(newest('mousedown'))).toBe(true)
  })

  it('a tap (click) keeps its text, path and component as before, the PIN in its text redacted', () => {
    document.body.innerHTML = PAGE
    fireEvent.click($('#home-panel'))
    const e = newest('click')
    expect(e.component).toBe('Scoreboard')
    expect(e.target).toMatchObject({ tagName: 'div', id: 'home-panel', path: expect.stringContaining('div#home-panel') })
    expect(e.target.textContent).toMatch(/^VBC Musterdorf 12 set 2/)
    expect(e.target.textContent).not.toContain('771234')
  })
})
