// Diagnostics watchers in jsdom: the page.load line, dialogs (open, content
// change, close / flash), clicks without their text, and box sizes with jumps
// from a stand-in ResizeObserver (jsdom has none).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWatchers, elementId, textHash, engineInfo } from '../watchers'
import { startRecorder, stopRecorder, flushDiagnostics } from '../recorder'

const frame = () => new Promise(r => setTimeout(r, 40))

describe('diagnostics watchers', () => {
  let sink, stop, observers
  beforeEach(() => {
    sink = { lines: [], write: async (b) => { sink.lines.push(...b.map(l => JSON.parse(l))) } }
    observers = []
    window.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.els = new Set(); observers.push(this) }
      observe(el) { this.els.add(el) }
      unobserve(el) { this.els.delete(el) }
      disconnect() { this.els.clear() }
    }
    document.body.innerHTML = '<div id="root"><div class="match-record"><div class="court"></div></div></div>'
    startRecorder({ sink, sessionId: 'w', storage: window.sessionStorage })
    stop = installWatchers({ win: window, appVersion: '2.4.1', platform: 'web', source: 'url' })
  })
  afterEach(async () => {
    stop()
    await stopRecorder()
    delete window.ResizeObserver
    document.body.innerHTML = ''
  })
  const kinds = (k) => sink.lines.filter(l => l.k === k)

  it('starts with page.load: version, platform, engine, screen and window', async () => {
    await flushDiagnostics()
    const load = kinds('page.load')[0].d
    expect(load).toMatchObject({ version: '2.4.1', platform: 'web', switch: 'url', url: '/' })
    expect(load.win).toHaveProperty('dpr')
    expect(load.screen).toHaveProperty('w')
    expect(kinds('diag.capabilities')[0].d).toMatchObject({ resizeObserver: true, longtask: false, layoutShift: false })
  })

  it('records dialogs opening, changing content, and closing (a short one as a flash)', async () => {
    const dlg = document.createElement('div')
    dlg.setAttribute('role', 'dialog')
    dlg.innerHTML = '<h3>Time-out 1</h3><p>Team A</p>'
    document.body.appendChild(dlg)
    await frame()
    dlg.querySelector('h3').textContent = 'Time-out 2'
    await frame()
    dlg.remove()
    await frame()
    await flushDiagnostics()
    const [open] = kinds('dialog.open')
    expect(open.d).toMatchObject({ id: 1, title: 'Time-out 1', hash: textHash('Time-out 1Team A'), open: 1 })
    expect(kinds('dialog.content')[0].d).toMatchObject({ id: 1, from: 'Time-out 1', to: 'Time-out 2' })
    const [close] = kinds('dialog.close')
    expect(close.d).toMatchObject({ id: 1, title: 'Time-out 2', flash: true, open: 0 })
  })

  it('records clicks by id, never by text, and keys outside fields only', async () => {
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="show-pin">771 234</button><button aria-label="7">7</button><input id="pin-field" type="password">')
    document.querySelector('[data-testid="show-pin"]').click()
    document.querySelector('[aria-label="7"]').click()
    const input = document.getElementById('pin-field')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushDiagnostics()
    const text = JSON.stringify(sink.lines)
    expect(text).not.toMatch(/771/)
    const clicks = kinds('ui.click').map(l => l.d.id)
    expect(clicks[0]).toBe('show-pin')
    expect(clicks[1]).not.toBe('7')
    expect(kinds('ui.key').map(l => l.d.key)).toEqual(['Escape'])
    expect(kinds('ui.key')[0].a).toBe(3)
  })

  it('records box sizes after the last action and flags a jump', async () => {
    await frame()
    const ro = observers[0]
    const court = [...ro.els].find(el => el.classList.contains('court'))
    expect(court).toBeTruthy()
    const report = (w, h) => ro.cb([{ target: court, contentRect: { width: w, height: h } }])
    report(800, 400)
    document.body.click()
    report(812, 406)
    report(800, 400)
    await flushDiagnostics()
    const boxes = kinds('geo.box').filter(l => l.d.el.startsWith('court'))
    expect(boxes.map(l => [l.d.w, l.d.h])).toEqual([[800, 400], [812, 406], [800, 400]])
    expect(boxes[1].d.after.a).toBe(1)
    const [jump] = kinds('geo.jump')
    expect(jump.d).toMatchObject({ size: [800, 400], via: [[812, 406]] })
    expect(jump.d.el).toMatch(/^court#/)
  })

  it('records the app\'s scale variables when they change', async () => {
    document.documentElement.style.setProperty('--scale-factor', '1.2')
    await frame()
    await flushDiagnostics()
    const vars = kinds('css.vars')
    expect(vars.at(-1).d.changed['--scale-factor']).toBe('1.2')
    document.documentElement.style.removeProperty('--scale-factor')
  })
})

describe('diagnostics helpers', () => {
  it('names an element by test id, help id, id or aria label without digits', () => {
    document.body.innerHTML = '<div role="dialog"><button data-help-id="rally-start"><span>Start</span></button><button aria-label="Close">x</button><button aria-label="1">1</button></div>'
    const [a, b, c] = document.querySelectorAll('button')
    expect(elementId(a.firstChild)).toMatchObject({ tag: 'button', id: 'rally-start', dialog: true })
    expect(elementId(b).id).toBe('Close')
    expect(elementId(c).id).toBe(null)
    document.body.innerHTML = ''
  })

  it('names a kit button without id or label by its caption, never one with a digit or a field', () => {
    document.body.innerHTML = '<div role="dialog"><button class="inline-flex">Confirm time-out</button><button class="inline-flex"> Cancel </button><button class="inline-flex">771 234</button><button class="inline-flex">Team PIN</button><div class="row">Claudia Moser</div><input class="f" value="Moser"></div>'
    const [confirm, cancel, pin, team] = document.querySelectorAll('button')
    expect(elementId(confirm).id).toBe('Confirm time-out')
    expect(elementId(cancel).id).toBe('Cancel')
    expect(elementId(pin).id).toBe('.inline-flex')
    expect(elementId(team).id).toBe('Team PIN')
    expect(elementId(document.querySelector('.row')).id).toBe('.row')
    expect(elementId(document.querySelector('input')).id).toBe('.f')
    document.body.innerHTML = ''
  })

  it('reads the engine from the user agent', () => {
    const gtk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    expect(engineInfo(gtk)).toMatchObject({ webkit: '605.1.15', chrome: null, linux: true, safari: '18.0' })
    expect(engineInfo('Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36')).toMatchObject({ android: '14', chrome: '126.0.0.0', wv: true })
  })

  it('hashes text stably', () => {
    expect(textHash('abc')).toBe(textHash('abc'))
    expect(textHash('abc')).not.toBe(textHash('abd'))
    expect(textHash('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

