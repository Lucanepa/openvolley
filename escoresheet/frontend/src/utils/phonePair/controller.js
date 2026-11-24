/**
 * Pair a phone: the scoring device's side, one pairing per tab
 * (docs/phone-keyboard-spec.md 5). Starts the pairing, follows it with the
 * long-poll, tells the relay which text field has the focus here (and its
 * text), and writes what the phone types into that field. Framework-free, so
 * it is tested with a plain DOM; components/phonePair/ renders it.
 *
 * While a phone is paired and `hideKeyboard` is on, a focused field gets
 * inputmode="none": this tablet's own on-screen keyboard stays closed (the
 * attribute is put back on blur and on unpair).
 */
import * as defaultApi from '../../lib/phonePairApi'
import { describeField, isOfficialField, isTypableField, moveFocus, pressEnter, setFieldValue, fieldIdOf } from './fields'
import { createTextHistory, mergeText } from './merge'

const RETRY_MS = 2000
const REPORT_DELAY_MS = 120 // typing on this device: one report per pause
const BLUR_GRACE_MS = 250 // a tap from one field to the next is no "no field" in between

/**
 * @param {{ api?: typeof defaultApi, doc?: Document, fallbackLabel?: string }} [opts]
 */
export function createPhonePairController({ api = defaultApi, doc = typeof document !== 'undefined' ? document : null, fallbackLabel = '' } = {}) {
  let state = {
    status: 'idle', // idle | starting | pending | paired | ended | error
    phoneConnected: false,
    handle: null,
    error: null, // { status, code } of a failed start
    ended: null, // 'closed' | 'expired' | 'unpaired' | 'stopped' (unpaired before a phone came)
    arrival: null, // { label, text, at }: text that arrived in an official field
    matchId: null,
    hideKeyboard: true,
  }
  const listeners = new Set()
  let ac = null
  let current = null // the focused typable field
  let applying = false
  let applied = 0 // the phone's last input n written here
  let after = 0 // the relay's last input seq taken
  let lastReport = null
  let reportTimer = null
  let blurTimer = null
  const savedInputMode = new WeakMap()
  const history = createTextHistory() // the texts the phone may have typed on

  const set = (patch) => {
    state = { ...state, ...patch }
    for (const fn of listeners) fn(state)
  }
  const live = () => state.status === 'pending' || state.status === 'paired'

  // --- this tablet's keyboard ------------------------------------------------

  function quietKeyboard(el) {
    if (!el || !state.hideKeyboard || state.status !== 'paired' || savedInputMode.has(el)) return
    savedInputMode.set(el, el.getAttribute('inputmode'))
    el.setAttribute('inputmode', 'none')
  }
  function restoreKeyboard(el) {
    if (!el || !savedInputMode.has(el)) return
    const was = savedInputMode.get(el)
    savedInputMode.delete(el)
    if (was == null) el.removeAttribute('inputmode')
    else el.setAttribute('inputmode', was)
  }

  // --- the focused field -------------------------------------------------------

  function report(now = false) {
    if (reportTimer) clearTimeout(reportTimer)
    reportTimer = null
    const send = () => {
      reportTimer = null
      if (!live() || !state.handle) return
      const field = current && current.isConnected ? describeField(current, fallbackLabel) : null
      if (field) history.note(field.id, field.text)
      const key = JSON.stringify([field, applied])
      if (key === lastReport) return
      lastReport = key
      api.focusPhonePair(state.handle, field, applied).then((r) => {
        if (!r.ok && (r.status === 409 || r.status === 404)) lastReport = null
      })
    }
    if (now) send()
    else reportTimer = setTimeout(send, REPORT_DELAY_MS)
  }

  function onFocusIn(e) {
    const el = e.target
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null }
    if (isTypableField(el)) {
      current = el
      quietKeyboard(el)
    } else {
      current = null
    }
    report(true)
  }
  function onFocusOut(e) {
    const el = e.target
    if (el !== current) return
    restoreKeyboard(el)
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      blurTimer = null
      if (doc.activeElement !== current) {
        current = isTypableField(doc.activeElement) ? doc.activeElement : null
        report(true)
      }
    }, BLUR_GRACE_MS)
  }
  function onInput(e) {
    if (applying || e.target !== current) return
    report(false)
  }

  function attach() {
    doc.addEventListener('focusin', onFocusIn, true)
    doc.addEventListener('focusout', onFocusOut, true)
    doc.addEventListener('input', onInput, true)
    const active = doc.activeElement
    current = isTypableField(active) ? active : null
  }
  function detach() {
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('input', onInput, true)
    if (current) restoreKeyboard(current)
    current = null
    if (reportTimer) clearTimeout(reportTimer)
    if (blurTimer) clearTimeout(blurTimer)
    reportTimer = null
    blurTimer = null
  }

  // --- what the phone sent -----------------------------------------------------

  function applyInputs(inputs) {
    let changed = false
    for (const inp of inputs) {
      after = Math.max(after, inp.seq || 0)
      applied = Math.max(applied, inp.n || 0)
      changed = true
      const el = current
      if (!el || !el.isConnected || fieldIdOf(el) !== inp.field) continue
      if (typeof inp.text === 'string') {
        const before = el.value
        const base = typeof inp.base === 'string' ? history.get(inp.field, inp.base) : null
        // a phone never overwrites what it was not shown: merged, or this device's text stays
        const next = mergeText(base, before, String(inp.text))
        let wrote = false
        if (next !== null) {
          applying = true
          try { wrote = setFieldValue(el, next) } finally { applying = false }
          history.note(inp.field, el.value)
        } else {
          lastReport = null // the phone gets this device's text back
        }
        if (wrote && isOfficialField(el)) {
          const text = el.value
          const added = text.startsWith(before) ? text.slice(before.length).trim() : text.trim()
          set({ arrival: { label: describeField(el, fallbackLabel).label, text: added, at: Date.now() } })
        }
      }
      if (inp.action === 'next' || inp.action === 'prev') {
        const next = moveFocus(el, inp.action)
        if (next !== el) { current = next; quietKeyboard(next) }
      } else if (inp.action === 'enter') {
        pressEnter(el)
      } else if (inp.action === 'done') {
        el.blur()
      }
    }
    if (changed) report(true)
  }

  // --- the session ---------------------------------------------------------------

  async function follow(handle, signal) {
    let knownState = 'pending'
    let knownPhone = false
    while (!signal.aborted) {
      const r = await api.waitPhonePair(handle, { knownState, after, knownPhone }, { signal })
      if (signal.aborted) return
      if (!r.ok) {
        if (r.code === 'OV_PAIR_ABORTED') return
        if (r.status === 404) { finish('expired'); return }
        await new Promise((res) => setTimeout(res, RETRY_MS))
        continue
      }
      if (r.state === 'closed' || r.state === 'expired') { finish(r.state); return }
      const connected = !!r.phone?.connected
      if (r.state !== knownState || connected !== knownPhone) {
        const wasPending = knownState === 'pending'
        knownState = r.state
        knownPhone = connected
        set({ status: r.state === 'paired' ? 'paired' : 'pending', phoneConnected: connected })
        if (wasPending && r.state === 'paired') {
          quietKeyboard(current)
          lastReport = null
          report(true)
        }
      }
      if (Array.isArray(r.inputs) && r.inputs.length) applyInputs(r.inputs)
    }
  }

  function finish(ended) {
    if (ac) ac.abort()
    ac = null
    detach()
    set({ status: 'ended', ended, phoneConnected: false, handle: null })
  }

  /**
   * Start a pairing (the match decides the auth, as Sign on phone).
   * @param {{ transport, apiBase, phoneBase, matchKey?, context, gamePin?, matchId? }} opts
   */
  async function start(opts) {
    if (live()) await unpair()
    applied = 0
    after = 0
    lastReport = null
    history.clear()
    set({ status: 'starting', error: null, ended: null, arrival: null, phoneConnected: false, handle: null, matchId: opts.matchId ?? null })
    const r = await api.startPhonePair(opts)
    if (!r.ok) {
      set({ status: 'error', error: { status: r.status, code: r.code } })
      return r
    }
    set({ status: 'pending', handle: r.handle })
    attach()
    ac = new AbortController()
    follow(r.handle, ac.signal)
    return r
  }

  /** Unpair: the relay forgets the phone, both sides told. One still waiting for its phone is stopped. */
  async function unpair({ keepalive = false } = {}) {
    const handle = state.handle
    if (ac) ac.abort()
    ac = null
    detach()
    if (live() || state.status === 'starting') set({ status: 'ended', ended: state.status === 'paired' ? 'unpaired' : 'stopped', phoneConnected: false, handle: null })
    if (handle) await api.closePhonePair(handle, { keepalive })
  }

  function setHideKeyboard(on) {
    set({ hideKeyboard: !!on })
    if (!current) return
    if (on) quietKeyboard(current)
    else restoreKeyboard(current)
  }

  return {
    start,
    unpair,
    setHideKeyboard,
    clearArrival: () => set({ arrival: null }),
    reset: () => { if (!live()) set({ status: 'idle', error: null, ended: null }) },
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
