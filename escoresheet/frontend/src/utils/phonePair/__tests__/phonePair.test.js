// @vitest-environment jsdom
/**
 * Pair a phone on the scoring device (docs/phone-keyboard-spec.md 5): which
 * fields a phone may type into (never PINs and passwords), how its text is
 * written (React's controlled inputs see an input event), the merge that keeps
 * what the phone was not shown, and the controller: focus reports, the
 * phone's inputs applied live, next field / Enter, the tablet keyboard kept
 * closed while paired, unpair.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { describeField, isSensitiveField, isTypableField, moveFocus, pressEnter, setFieldValue } from '../fields'
import { createTextHistory, mergeText, textHash } from '../merge'
import { createPhonePairController } from '../controller'

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

function html(markup) {
  document.body.innerHTML = markup
  return (sel) => document.querySelector(sel)
}

describe('fields a phone may type into', () => {
  it('text inputs and text areas yes; buttons, checkboxes, numbers, disabled and read-only no', () => {
    const $ = html(`
      <input id="a" type="text"><input id="b"><textarea id="c"></textarea><input id="d" type="search">
      <input id="e" type="checkbox"><input id="f" type="number"><button id="g">x</button>
      <input id="h" disabled><textarea id="i" readonly></textarea>`)
    for (const id of ['a', 'b', 'c', 'd']) expect(isTypableField($(`#${id}`)), id).toBe(true)
    for (const id of ['e', 'f', 'g', 'h', 'i']) expect(isTypableField($(`#${id}`)), id).toBe(false)
  })

  it('never PINs, passwords, one-time codes, tokens, or what is marked off', () => {
    const $ = html(`
      <input id="p1" type="password"><input id="p2" autocomplete="one-time-code"><input id="p3" name="refereePin">
      <input id="p4" aria-label="Game PIN"><label for="p5">Bench PIN (away)</label><input id="p5">
      <input id="p6" data-testid="upload-token"><input id="p7" data-ov-phone="off"><input id="p8" placeholder="Passwort">
      <input id="ok1" aria-label="Spinner name"><input id="ok2" name="shipping">`)
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      expect(isSensitiveField($(`#${id}`)), id).toBe(true)
      expect(isTypableField($(`#${id}`)), id).toBe(false)
    }
    expect(isTypableField($('#ok1'))).toBe(true)
    expect(isTypableField($('#ok2'))).toBe(true)
  })

  it('describes a field by its label, kind, text and cap', () => {
    const $ = html(`<label for="n">First name</label><input id="n" maxlength="40" value="Lea"><textarea aria-label="Remarks">Line 1
</textarea>`)
    expect(describeField($('#n'))).toMatchObject({ label: 'First name', kind: 'line', text: 'Lea', maxLength: 40 })
    expect(describeField($('textarea'))).toMatchObject({ label: 'Remarks', kind: 'multiline', text: 'Line 1\n', maxLength: 8000 })
    expect(describeField($('#n')).id).toBe(describeField($('#n')).id) // stable per element
  })

  it('writes like typing: the value and a bubbling input event; the maxlength holds', () => {
    const $ = html('<input id="n" maxlength="5">')
    const seen = []
    document.body.addEventListener('input', (e) => seen.push(e.target.value))
    expect(setFieldValue($('#n'), 'Hello world')).toBe(true)
    expect($('#n').value).toBe('Hello')
    expect(seen).toEqual(['Hello'])
    expect(setFieldValue($('#n'), 'Hello')).toBe(false) // no change, no event
  })

  it('next / previous field inside the open dialog, and Enter submits a form', () => {
    const $ = html(`<input id="outside"><div role="dialog"><input id="a"><button>b</button><input id="pin" name="gamePin"><textarea id="c"></textarea></div>
      <form id="f"><input id="x"></form>`)
    $('#a').focus()
    expect(moveFocus($('#a'), 'next').id).toBe('c') // the PIN field is skipped, the outside field too
    expect(document.activeElement.id).toBe('c')
    expect(moveFocus($('#c'), 'next').id).toBe('a')
    expect(moveFocus($('#a'), 'prev').id).toBe('c')
    const submit = vi.fn((e) => e.preventDefault())
    $('#f').addEventListener('submit', submit)
    $('#f').requestSubmit = () => submit({ preventDefault() {} })
    pressEnter($('#x'))
    expect(submit).toHaveBeenCalledTimes(1)
    // a handler that takes the key: no submit
    $('#x').addEventListener('keydown', (e) => e.preventDefault())
    pressEnter($('#x'))
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('the merge: a phone never overwrites what it was not shown', () => {
  it('cases', () => {
    expect(mergeText('a', 'a', 'ab')).toBe('ab') // only the phone typed
    expect(mergeText('a', 'ac', 'a')).toBe('ac') // only the tablet typed
    expect(mergeText('a', 'a\nT', 'a P')).toBe('a\nT P') // both added at the end
    expect(mergeText('abc', 'xbc', 'abcd')).toBeNull() // a real conflict: the tablet keeps its text
    expect(mergeText(null, '', 'new')).toBe('new') // unknown base, empty field
    expect(mergeText(null, 'Old', 'Old and more')).toBe('Old and more')
    expect(mergeText(null, 'Old line', 'Something else')).toBeNull()
  })

  it('the hash is the phone page\'s (FNV-1a over UTF-16, 8 hex)', () => {
    expect(textHash('')).toBe('811c9dc5')
    expect(textHash('Actual game start: 20:31\n')).toBe('a9c2fff7')
    expect(textHash('\u{1F44D}')).toMatch(/^[0-9a-f]{8}$/)
    const h = createTextHistory(2)
    h.note('f', 'a'); h.note('f', 'b'); h.note('f', 'c')
    expect(h.get('f', textHash('a'))).toBeNull()
    expect(h.get('f', textHash('c'))).toBe('c')
    expect(h.get('g', textHash('c'))).toBeNull()
  })
})

/** A fake relay: the controller's api with a queue of wait answers. */
function fakeApi() {
  const waits = []
  const calls = { focus: [], close: 0, start: [] }
  let release = null
  const api = {
    startPhonePair: async (o) => { calls.start.push(o); return { ok: true, handle: { watch: 'w', token: 't', code: 'ABCDEFGH', apiBase: '', phoneBase: 'http://x', startedAt: Date.now() } } },
    focusPhonePair: async (h, field, applied) => { calls.focus.push({ field, applied }); return { ok: true, v: calls.focus.length } },
    closePhonePair: async () => { calls.close++; return { ok: true } },
    waitPhonePair: (h, known, { signal }) => new Promise((resolve) => {
      const next = waits.shift()
      if (next) return resolve(next)
      release = resolve
      signal.addEventListener('abort', () => resolve({ ok: false, code: 'OV_PAIR_ABORTED' }))
    }),
  }
  const push = (answer) => { if (release) { const r = release; release = null; r(answer) } else waits.push(answer) }
  return { api, calls, push }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the controller', () => {
  it('pairs, reports the focused field, applies the phone\'s text live, keeps the tablet keyboard closed, unpairs', async () => {
    const $ = html(`<div role="dialog"><textarea id="r" aria-label="Remarks" data-ov-phone="official">Old
</textarea><input id="n" aria-label="Hall"><input id="pin" aria-label="Game PIN"></div>`)
    const { api, calls, push } = fakeApi()
    const c = createPhonePairController({ api })
    await c.start({ transport: 'lan', apiBase: '', phoneBase: 'http://x', context: { home: 'A', away: 'B' }, matchId: 7 })
    expect(c.getState()).toMatchObject({ status: 'pending', matchId: 7 })
    push({ ok: true, state: 'paired', seq: 0, inputs: [], phone: { connected: true } })
    await tick()
    expect(c.getState()).toMatchObject({ status: 'paired', phoneConnected: true })

    $('#r').focus()
    await tick()
    expect($('#r').getAttribute('inputmode')).toBe('none')
    const f = calls.focus.at(-1).field
    expect(f).toMatchObject({ label: 'Remarks', kind: 'multiline', text: 'Old\n' })

    // the phone types on the text it was shown
    push({ ok: true, state: 'paired', seq: 1, phone: { connected: true }, inputs: [{ seq: 1, n: 1, field: f.id, text: 'Old\nNew line', base: textHash('Old\n') }] })
    await tick()
    expect($('#r').value).toBe('Old\nNew line')
    expect(c.getState().arrival).toMatchObject({ label: 'Remarks', text: 'New line' })
    expect(calls.focus.at(-1)).toMatchObject({ applied: 1, field: { text: 'Old\nNew line' } })

    // next field (the PIN field is skipped), then text there
    push({ ok: true, state: 'paired', seq: 2, phone: { connected: true }, inputs: [{ seq: 2, n: 2, field: f.id, action: 'next' }] })
    await tick()
    expect(document.activeElement.id).toBe('n')
    expect($('#n').getAttribute('inputmode')).toBe('none')
    expect($('#r').hasAttribute('inputmode')).toBe(false) // given back on blur
    const nId = calls.focus.at(-1).field.id
    push({ ok: true, state: 'paired', seq: 3, phone: { connected: true }, inputs: [{ seq: 3, n: 3, field: nId, text: 'Halle A' }] })
    await tick()
    expect($('#n').value).toBe('Halle A')

    // a PIN field: the phone sees no field
    $('#pin').focus()
    await tick()
    expect(calls.focus.at(-1).field).toBeNull()

    await c.unpair()
    expect(c.getState()).toMatchObject({ status: 'ended', ended: 'unpaired' })
    expect(calls.close).toBe(1)
  })

  it('a stale phone text never overwrites the tablet\'s newer text', async () => {
    const $ = html('<textarea id="r" aria-label="Remarks">A\n</textarea>')
    const { api, calls, push } = fakeApi()
    const c = createPhonePairController({ api })
    await c.start({ transport: 'lan', apiBase: '', phoneBase: 'http://x', context: { home: 'A', away: 'B' } })
    push({ ok: true, state: 'paired', seq: 0, inputs: [], phone: { connected: true } })
    await tick()
    $('#r').focus()
    await tick()
    const id = calls.focus.at(-1).field.id
    // the scorer replaces the text on the tablet; the phone, on the old text, sends something else
    setFieldValue($('#r'), 'Rewritten here')
    push({ ok: true, state: 'paired', seq: 1, phone: { connected: true }, inputs: [{ seq: 1, n: 1, field: id, text: 'A\nfrom the phone', base: textHash('A\n') }] })
    await tick()
    expect($('#r').value).toBe('Rewritten here')
    c.unpair()
  })

  it('a pairing still waiting for its phone is stopped (Stop pairing), the relay told', async () => {
    html('<input id="n">')
    const { api, calls } = fakeApi()
    const c = createPhonePairController({ api })
    await c.start({ transport: 'lan', apiBase: '', phoneBase: 'http://x', context: { home: 'A', away: 'B' } })
    expect(c.getState().status).toBe('pending')
    await c.unpair()
    expect(c.getState()).toMatchObject({ status: 'ended', ended: 'stopped', handle: null })
    expect(calls.close).toBe(1)
  })

  it('the relay ending the pairing (closed / expired) ends it here', async () => {
    html('<input id="n">')
    const { api, push } = fakeApi()
    const c = createPhonePairController({ api })
    await c.start({ transport: 'lan', apiBase: '', phoneBase: 'http://x', context: { home: 'A', away: 'B' } })
    push({ ok: true, state: 'expired' })
    await tick()
    expect(c.getState()).toMatchObject({ status: 'ended', ended: 'expired' })
  })

  it('a failed start says why', async () => {
    const c = createPhonePairController({ api: { startPhonePair: async () => ({ ok: false, status: 403, code: 'OV_PAIR_MATCH' }) } })
    await c.start({ transport: 'cloud', apiBase: '', phoneBase: '', context: { home: 'A', away: 'B' } })
    expect(c.getState()).toMatchObject({ status: 'error', error: { status: 403, code: 'OV_PAIR_MATCH' } })
  })
})
