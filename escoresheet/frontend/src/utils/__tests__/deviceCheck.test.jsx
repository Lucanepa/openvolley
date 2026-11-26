// The device check (utils/deviceCheck, owner 22.11.2026): the tier from the
// measures, the recommendations, the stored result and the Home card's rule,
// and that it never runs while a match is open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  AUTO_CHECK_DELAY_MS, CHECK_BUDGET_MS, CHECK_KEY, CHECK_VERSION, PROBE_STILL, RECOMMENDED, TIER_LIMITS, WORK_EVENTS, WORK_REPEAT, WORK_RUNS, WORK_SPLIT, WORK_STEPS,
  answerDeviceCheck, appPlatformOf, cardChanges, changesFor, checkDeviceNow, checkDue, classify, deviceCheckRunning, getDeviceCheck, homeQuietForCheck,
  measureLayout, measureWork, median, readCheck, readHints, recommend, recommendationOf, resetDeviceCheckForTests, runDeviceCheck,
  saveCheck, setDeviceCheck, syntheticMatch, useAutoDeviceCheck, useDeviceCheck, useDeviceCheckRunning
} from '../deviceCheck'

const noPause = () => Promise.resolve()
/** A clock that moves `step` ms each time it is read. */
const tickingClock = (step = 1) => {
  let t = 0
  return () => (t += step)
}
const result = (over = {}) => ({
  v: CHECK_VERSION, at: Date.UTC(2026, 10, 22, 20, 0), tier: 'slow', score: 140, workMs: 95, workRunsMs: [95, 96, 94], layoutMs: 45, layoutRunsMs: [45, 44, 46],
  hints: { platform: 'android-app', cores: 8, memoryGb: 2, dpr: 1.5, screen: '1340x800', reducedMotion: false },
  recommended: { ...RECOMMENDED.slow }, answer: null, ...over
})
const ALL_ON = { blur: true, motion: true, clockSeconds: true, pdfSharp: true }

beforeEach(() => {
  localStorage.clear()
  resetDeviceCheckForTests()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
  resetDeviceCheckForTests()
})

describe('classify: the tier', () => {
  it('score = work + layout against the limits', () => {
    expect(TIER_LIMITS).toEqual({ fast: 66, ok: 112 })
    expect(classify({ workMs: 40, layoutMs: 25 })).toBe('fast')
    expect(classify({ workMs: 40, layoutMs: 26 })).toBe('ok')
    expect(classify({ workMs: 80, layoutMs: 31.9 })).toBe('ok')
    expect(classify({ workMs: 80, layoutMs: 32 })).toBe('slow')
    // no layout measure (no document): the work alone
    expect(classify({ workMs: 50 })).toBe('fast')
  })

  // the calibration's medians (deviceCheck.js comment): 1x and 2x fast, 4x ok,
  // 6x (the hall tablet's stand-in) slow
  for (const [rate, workMs, layoutMs, tier] of [
    ['1x', 16.9, 9.4, 'fast'], ['2x', 32.1, 15.9, 'fast'], ['2x, its slowest check', 41, 16.6, 'fast'],
    ['4x', 65.2, 29.6, 'ok'], ['4x, its slowest check', 70, 30.7, 'ok'],
    ['6x', 93.9, 45, 'slow'], ['6x, its fastest check', 83.5, 39, 'slow'], ['8x', 126.9, 59.5, 'slow']
  ]) {
    it(`calibration ${rate}: ${tier}`, () => {
      expect(classify({ workMs, layoutMs, hints: { cores: 16, memoryGb: 8 } })).toBe(tier)
    })
  }

  it('little memory or few cores: one tier slower, never past slow', () => {
    expect(classify({ workMs: 20, layoutMs: 5, hints: { memoryGb: 1 } })).toBe('ok')
    expect(classify({ workMs: 20, layoutMs: 5, hints: { cores: 2 } })).toBe('ok')
    expect(classify({ workMs: 80, layoutMs: 5, hints: { cores: 2 } })).toBe('slow')
    expect(classify({ workMs: 200, layoutMs: 5, hints: { memoryGb: 0.5 } })).toBe('slow')
    // 2 GB and 4 cores (most tablets), or nothing reported (Safari, Firefox): as measured
    expect(classify({ workMs: 20, layoutMs: 5, hints: { memoryGb: 2, cores: 4 } })).toBe('fast')
    expect(classify({ workMs: 20, layoutMs: 5, hints: { memoryGb: null, cores: null } })).toBe('fast')
  })

  it('no measure: no tier; no hints: as measured', () => {
    expect(classify({ workMs: NaN })).toBe(null)
    expect(classify()).toBe(null)
    expect(classify({ workMs: 20, hints: null })).toBe('fast')
  })
})

describe('recommend: the switches per tier', () => {
  it('the owner\'s table', () => {
    expect(recommend('slow')).toEqual({ blur: false, motion: false, clockSeconds: false, pdfSharp: false })
    expect(recommend('ok')).toEqual({ blur: false, motion: true, clockSeconds: true, pdfSharp: true })
    expect(recommend('fast')).toEqual(ALL_ON)
    expect(recommend('nope')).toBe(null)
  })

  it('reduced motion: no animations, whatever the tier', () => {
    for (const tier of ['fast', 'ok', 'slow']) {
      expect(recommend(tier, { reducedMotion: true }).motion, tier).toBe(false)
    }
    expect(recommend('fast', { reducedMotion: true })).toEqual({ ...ALL_ON, motion: false })
    // the stored result's own list, or its tier and hints
    expect(recommendationOf(result({ tier: 'fast', recommended: undefined, hints: { reducedMotion: true } }))).toEqual({ ...ALL_ON, motion: false })
  })
})

describe('the work and the layout probe', () => {
  it('the synthetic match is the same on every device: 400 events, about 330 KB', () => {
    const a = syntheticMatch()
    expect(a.events).toHaveLength(WORK_EVENTS)
    expect(JSON.stringify(a)).toBe(JSON.stringify(syntheticMatch()))
    const bytes = JSON.stringify(a).length
    expect(bytes).toBeGreaterThan(300_000)
    expect(bytes).toBeLessThan(450_000)
    expect(new Set(a.events.map((e) => e.type))).toEqual(new Set(['lineup', 'rally_start', 'point']))
  })

  it('every step does its work and returns a number', () => {
    const state = { match: syntheticMatch(60) }
    for (const step of WORK_STEPS) expect(Number.isFinite(step(state, 1))).toBe(true)
  })

  it('a warm-up run, then the median of the measured runs; each step in parts, a pause before each', async () => {
    const pause = vi.fn(noPause)
    const out = await measureWork({ events: 30, pause, now: tickingClock(1) })
    expect(out.runsMs).toHaveLength(WORK_RUNS)
    expect(out.medianMs).toBe(median(out.runsMs))
    expect(pause).toHaveBeenCalledTimes((WORK_RUNS + 1) * WORK_STEPS.length * WORK_SPLIT)
    expect(WORK_REPEAT % WORK_SPLIT).toBe(0)
  })

  it('stops at the next step when keepGoing turns false, and gives nothing', async () => {
    let steps = 0
    const out = await measureWork({ events: 30, pause: noPause, keepGoing: () => ++steps < 5 })
    expect(out).toBe(null)
    expect(steps).toBe(5)
  })

  it('past the budget: no further run once one is measured', async () => {
    const out = await measureWork({ events: 30, pause: noPause, overBudget: () => true })
    expect(out.runsMs).toHaveLength(1)
  })

  it('the layout probe: an invisible box off the screen, gone afterwards', async () => {
    const seen = []
    const out = await measureLayout({
      pause: () => { seen.push(document.querySelector('[data-device-check]')?.style.cssText || null); return noPause() },
      now: tickingClock(2)
    })
    expect(out.runsMs).toHaveLength(3)
    expect(document.querySelector('[data-device-check]')).toBe(null)
    const style = seen.find(Boolean)
    expect(style).toMatch(/visibility: hidden/)
    expect(style).toMatch(/left: -20000px/)
    expect(style).toMatch(/pointer-events: none/)
  })

  it('the layout probe runs still: no transition, no animation on its box, rows and cells (reduced motion measured as fast as without)', async () => {
    expect(PROBE_STILL).toBe('transition:none!important;animation:none!important;')
    let attrs = null
    await measureLayout({
      pause: () => {
        const box = document.querySelector('[data-device-check]')
        if (box && box.firstChild && !attrs) attrs = [box, ...box.querySelectorAll('div')].map((el) => el.getAttribute('style'))
        return noPause()
      },
      now: tickingClock(2)
    })
    // the box, 30 rows and their 8 cells each
    expect(attrs).toHaveLength(1 + 30 + 30 * 8)
    for (const style of attrs) {
      expect(style.replace(/\s/g, '')).toMatch(/transition:none!important/)
      expect(style.replace(/\s/g, '')).toMatch(/animation:none!important/)
    }
  })

  it('a device that checked with version 1 (reduced motion measured too slow) checks again', () => {
    expect(CHECK_VERSION).toBeGreaterThanOrEqual(2)
    expect(checkDue(result({ v: 1 }))).toBe(true)
  })

  it('the layout probe: stopped, false (and the box gone); no document, null', async () => {
    let n = 0
    expect(await measureLayout({ pause: noPause, keepGoing: () => ++n < 3 })).toBe(false)
    expect(document.querySelector('[data-device-check]')).toBe(null)
    expect(await measureLayout({ doc: null })).toBe(null)
  })

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([NaN])).toBe(null)
  })
})

describe('hints', () => {
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T220; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36'
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  const fakeWindow = (extra = {}, nav = {}) => ({ navigator: { userAgent: 'x', ...nav }, ...extra })

  it('the platform: Android app, iOS app, desktop app, web', () => {
    const capacitor = { Capacitor: { isNativePlatform: () => true } }
    expect(appPlatformOf(fakeWindow(capacitor, { userAgent: ANDROID_UA }))).toBe('android-app')
    expect(appPlatformOf(fakeWindow(capacitor, { userAgent: IPAD_UA }))).toBe('ios-app')
    expect(appPlatformOf(fakeWindow({ __TAURI__: {} }))).toBe('desktop-app')
    expect(appPlatformOf(fakeWindow({ electronAPI: {} }))).toBe('desktop-app')
    expect(appPlatformOf(fakeWindow({}, { userAgent: ANDROID_UA }))).toBe('web')
    expect(appPlatformOf(undefined)).toBe('web')
  })

  it('numbers and booleans only, missing ones null', () => {
    const win = fakeWindow({ devicePixelRatio: 1.5, screen: { width: 1340, height: 800 }, matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }, { hardwareConcurrency: 8, deviceMemory: 2 })
    expect(readHints(win)).toEqual({ platform: 'web', cores: 8, memoryGb: 2, dpr: 1.5, screen: '1340x800', reducedMotion: true })
    expect(readHints(fakeWindow())).toEqual({ platform: 'web', cores: null, memoryGb: null, dpr: 1, screen: null, reducedMotion: false })
    expect(readHints(fakeWindow({ matchMedia: () => { throw new Error('no') } })).reducedMotion).toBe(false)
  })
})

describe('runDeviceCheck', () => {
  it('a result with the tier, the measures, the hints and the recommendation, unanswered', async () => {
    const r = await runDeviceCheck({ win: window, pause: noPause, now: tickingClock(1), wallClock: () => 1234 })
    expect(r).toMatchObject({ v: CHECK_VERSION, at: 1234, answer: null })
    expect(['fast', 'ok', 'slow']).toContain(r.tier)
    expect(r.score).toBe(Math.round((r.workMs + r.layoutMs) * 10) / 10)
    expect(r.workRunsMs).toHaveLength(3)
    expect(r.layoutRunsMs).toHaveLength(3)
    expect(r.recommended).toEqual(recommend(r.tier, { reducedMotion: r.hints.reducedMotion }))
    // nothing personal: numbers, booleans and the platform's name
    expect(JSON.stringify(r)).not.toMatch(/Mozilla|userAgent/)
  })

  it('a reduced-motion device: animations off in the recommendation', async () => {
    const win = { document, navigator: {}, matchMedia: () => ({ matches: true }) }
    const r = await runDeviceCheck({ win, pause: noPause, now: tickingClock(1) })
    expect(r.recommended.motion).toBe(false)
  })

  it('stopped: null, and nothing is kept', async () => {
    let n = 0
    expect(await runDeviceCheck({ win: window, pause: noPause, keepGoing: () => ++n < 10 })).toBe(null)
    let m = 0
    // stopped in the layout probe
    const steps = (WORK_RUNS + 1) * WORK_STEPS.length * WORK_SPLIT
    expect(await runDeviceCheck({ win: window, pause: noPause, keepGoing: () => ++m <= steps + 1 })).toBe(null)
    expect(localStorage.getItem(CHECK_KEY)).toBe(null)
  })

  it('a slow device past the budget measures one run of each', async () => {
    const r = await runDeviceCheck({ win: window, pause: noPause, now: tickingClock(CHECK_BUDGET_MS) })
    expect(r.workRunsMs).toHaveLength(1)
    expect(r.layoutRunsMs).toHaveLength(1)
    expect(r.tier).toBe('slow')
  })
})

describe('the stored result', () => {
  it('kept and read back; anything else is no result', () => {
    expect(readCheck()).toBe(null)
    expect(saveCheck(result())).toBe(true)
    expect(readCheck()).toEqual(result())
    localStorage.setItem(CHECK_KEY, '{not json')
    expect(readCheck()).toBe(null)
    localStorage.setItem(CHECK_KEY, JSON.stringify({ v: 1, tier: 'turbo', at: 1 }))
    expect(readCheck()).toBe(null)
  })

  it('storage that throws: no result read, the new one holds for this page', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(readCheck()).toBe(null)
    expect(getDeviceCheck()).toBe(null)
    expect(saveCheck(result())).toBe(false)
    setDeviceCheck(result())
    expect(getDeviceCheck()).toEqual(result())
    expect(answerDeviceCheck('kept', { wallClock: () => 5 })).toMatchObject({ answer: 'kept', answeredAt: 5 })
    expect(checkDue(getDeviceCheck())).toBe(false)
  })

  it('due: never checked, or checked by another CHECK_VERSION', () => {
    expect(checkDue(null)).toBe(true)
    expect(checkDue(result({ v: CHECK_VERSION - 1 }))).toBe(true)
    expect(checkDue(result())).toBe(false)
    expect(checkDue(result({ answer: 'kept' }))).toBe(false)
  })
})

describe('the Home card\'s rule', () => {
  it('the switches the result would change, in order', () => {
    expect(changesFor(result(), ALL_ON)).toEqual([
      { name: 'blur', value: false }, { name: 'motion', value: false }, { name: 'clockSeconds', value: false }, { name: 'pdfSharp', value: false }
    ])
    // the Android app's defaults: blur and the sharp PDF already off
    expect(changesFor(result(), { blur: false, motion: true, clockSeconds: true, pdfSharp: false })).toEqual([
      { name: 'motion', value: false }, { name: 'clockSeconds', value: false }
    ])
    expect(changesFor(result({ tier: 'fast', recommended: { ...ALL_ON } }), { ...ALL_ON, blur: false })).toEqual([{ name: 'blur', value: true }])
  })

  it('shown only for an unanswered result of this version that changes something', () => {
    expect(cardChanges(result(), ALL_ON)).toHaveLength(4)
    expect(cardChanges(result(), RECOMMENDED.slow)).toEqual([])
    expect(cardChanges(result({ answer: 'kept' }), ALL_ON)).toEqual([])
    expect(cardChanges(result({ answer: 'applied' }), ALL_ON)).toEqual([])
    expect(cardChanges(result({ v: CHECK_VERSION + 1 }), ALL_ON)).toEqual([])
    expect(cardChanges(null, ALL_ON)).toEqual([])
  })

  it('Home quiet: no match, Home shown, no first-start dialog, nothing being opened or covering it', () => {
    const quiet = { matchId: null, homeVisible: true, firstStartDialog: false, openingMatch: false, covered: false }
    expect(homeQuietForCheck(quiet)).toBe(true)
    expect(homeQuietForCheck({ ...quiet, matchId: 7 })).toBe(false)
    expect(homeQuietForCheck({ ...quiet, homeVisible: false })).toBe(false)
    expect(homeQuietForCheck({ ...quiet, firstStartDialog: true })).toBe(false)
    expect(homeQuietForCheck({ ...quiet, openingMatch: true })).toBe(false)
    expect(homeQuietForCheck({ ...quiet, covered: true })).toBe(false)
  })

  // Owner follow-up 26.11.2026: the device check and its card wait while the
  // "Your first match" walkthrough runs (Home is its first chapter), and come
  // as usual once it has ended
  it('Home is not quiet while the walkthrough runs', () => {
    const quiet = { matchId: null, homeVisible: true, firstStartDialog: false, openingMatch: false, covered: false }
    expect(homeQuietForCheck({ ...quiet, tour: true })).toBe(false)
    expect(homeQuietForCheck({ ...quiet, tour: false })).toBe(true)
  })
})

describe('checkDeviceNow', () => {
  it('keeps the result and tells useDeviceCheck; one check at a time', async () => {
    const run = vi.fn(async () => result({ tier: 'ok', recommended: { ...RECOMMENDED.ok } }))
    let shown = null
    function Shown() {
      shown = useDeviceCheck()
      return null
    }
    render(<Shown />)
    let a
    let b
    await act(async () => {
      a = checkDeviceNow({ run })
      b = checkDeviceNow({ run })
      await a
    })
    expect(a).toBe(b)
    expect(run).toHaveBeenCalledTimes(1)
    expect(shown.tier).toBe('ok')
    expect(JSON.parse(localStorage.getItem(CHECK_KEY)).tier).toBe('ok')
  })

  it('a check that fails or stops keeps nothing', async () => {
    await checkDeviceNow({ run: async () => { throw new Error('boom') } })
    await checkDeviceNow({ run: async () => null })
    expect(getDeviceCheck()).toBe(null)
  })

  it('without a keepGoing of its own, a hidden page stops it', async () => {
    const win = { document: { hidden: false } }
    const run = async ({ keepGoing }) => {
      win.document.hidden = true
      return keepGoing() ? result() : null
    }
    expect(await checkDeviceNow({ win, run })).toBe(null)
    expect(getDeviceCheck()).toBe(null)
  })

  it('its start and its end tell useDeviceCheckRunning (Options: Checking..., also for the automatic check)', async () => {
    let finish
    const run = () => new Promise((resolve) => { finish = resolve })
    let seen = null
    function Running() {
      seen = useDeviceCheckRunning()
      return null
    }
    render(<Running />)
    expect(seen).toBe(false)
    let p
    act(() => { p = checkDeviceNow({ run }) })
    expect(seen).toBe(true)
    expect(deviceCheckRunning()).toBe(true)
    await act(async () => {
      await Promise.resolve()
      finish(null)
      await p
    })
    expect(seen).toBe(false)
    expect(deviceCheckRunning()).toBe(false)
  })
})

describe('useAutoDeviceCheck: once per device, on a quiet Home only', () => {
  function Auto({ ready, ...opts }) {
    useAutoDeviceCheck(ready, opts)
    return null
  }
  const idleWindow = () => {
    const win = { document: { hidden: false }, requestIdleCallback: vi.fn((cb) => setTimeout(cb, 0)), cancelIdleCallback: vi.fn() }
    return win
  }

  it('runs once after the delay and an idle moment, and not again', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => result())
    const win = idleWindow()
    const { rerender } = render(<Auto ready win={win} run={run} />)
    act(() => { vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS - 1) })
    expect(run).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1); await vi.runAllTimersAsync() })
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(readCheck().tier).toBe('slow')
    rerender(<Auto ready={false} win={win} run={run} />)
    rerender(<Auto ready win={win} run={run} />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never while a match is open: not ready, or a match screen noted open', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => result())
    render(<Auto ready={false} win={idleWindow()} run={run} />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(run).not.toHaveBeenCalled()
    render(<Auto ready matchOpen={() => true} win={idleWindow()} run={run} />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(run).not.toHaveBeenCalled()
    expect(readCheck()).toBe(null)
  })

  it('a match opened while it runs: it stops at its next step and keeps nothing', async () => {
    vi.useFakeTimers()
    let keepGoingSeen = null
    let release
    const run = vi.fn(({ keepGoing }) => {
      keepGoingSeen = keepGoing
      return new Promise((resolve) => { release = () => resolve(keepGoing() ? result() : null) })
    })
    const { rerender } = render(<Auto ready win={idleWindow()} run={run} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS + 1) })
    expect(run).toHaveBeenCalledTimes(1)
    expect(keepGoingSeen()).toBe(true)
    // the scorer opens a match: Home is no longer quiet
    rerender(<Auto ready={false} win={idleWindow()} run={run} />)
    expect(keepGoingSeen()).toBe(false)
    await act(async () => { release(); await vi.runAllTimersAsync() })
    expect(readCheck()).toBe(null)
    expect(getDeviceCheck()).toBe(null)
  })

  it('a hidden page stops it; not due (checked already): nothing runs', async () => {
    vi.useFakeTimers()
    let keepGoingSeen = null
    const run = vi.fn(async ({ keepGoing }) => { keepGoingSeen = keepGoing; return null })
    const win = idleWindow()
    render(<Auto ready win={win} run={run} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS + 1) })
    win.document.hidden = true
    expect(keepGoingSeen()).toBe(false)
    resetDeviceCheckForTests()
    saveCheck(result({ answer: 'kept' }))
    const run2 = vi.fn(async () => result())
    render(<Auto ready win={idleWindow()} run={run2} />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(run2).not.toHaveBeenCalled()
  })

  it('without requestIdleCallback (Safari): after the delay', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => result())
    render(<Auto ready win={{ document: { hidden: false } }} run={run} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS) })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
