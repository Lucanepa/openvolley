// Property test (audit round 3, unit subs-liberos) of the app's one substitution
// rule (domain/interruptionRequests substitutionIllegalReason + the 6-per-set
// count) against an INDEPENDENT model of FIVB 2025-2028 15.5-15.6 (regular
// substitutions), 15.2.3 (a completed rally between leaving and coming back),
// 19.3.1.3 / 19.3.2 (no libero in or out, not the player a libero replaced),
// 21.3.2-21.3.3 (an expelled player out for the set, a disqualified one for the
// match). The model does not import the app's rules.
import { describe, it, expect } from 'vitest'
import { substitutionIllegalReason, substitutionRequestIssues, classifyLiveSubstitution, isSentOff } from '../interruptionRequests'
import { countRegularSubstitutions, validateManualSubstitution } from '../substitutions'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const LIBERO = 12
const roster = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, ...(i + 1 === LIBERO ? { libero: 'libero1' } : {}) }))

// The model of one team in one set (set 1), the court with the libero row
class Model {
  constructor() {
    this.events = []
    this.seq = 1
    this.lineup = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
    this.starters = new Set([1, 2, 3, 4, 5, 6])
    this.partner = new Map() // starter -> sub (while out or after); sub -> starter
    this.returned = new Set() // starters back (cycle complete)
    this.subOut = new Set() // substitutes who left again
    this.enteredAtRally = new Map() // number -> rallies count when he came in
    this.leftAtRally = new Map() // number -> rallies count when he went out
    this.rallies = 0
    this.regular = 0
    this.sentOff = new Set() // expelled this set / disqualified
    this.libero = null // { pos, replaced }
    this.ev('lineup', { team: 'home', lineup: this.str(this.lineup), isInitial: true })
    this.ev('lineup', { team: 'away', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true })
  }

  str(lu) { return Object.fromEntries(Object.entries(lu).map(([k, v]) => [k, String(v)])) }
  ev(type, payload, { sub = false } = {}) {
    const seq = sub ? Math.floor(this.seq - 1) + 0.1 : this.seq++
    this.events.push({ id: this.events.length + 1, type, setIndex: 1, seq, payload })
  }

  onCourt(n) { return Object.values(this.lineup).includes(n) }

  point() {
    this.rallies++
    this.ev('point', { team: 'home' })
  }

  // FIVB: is a regular substitution out -> in legal now?
  legal(out, inn) {
    if (!this.onCourt(out) || this.onCourt(inn)) return false
    if (out === LIBERO || inn === LIBERO) return false
    if (this.libero && this.libero.replaced === inn) return false
    if (this.sentOff.has(inn)) return false
    if (this.regular >= 6) return false
    if (this.starters.has(out)) {
      if (this.returned.has(out)) return false // a starter leaves once (15.5.2)
      // a fresh substitute only
      if (this.starters.has(inn)) return false
      if (this.partner.has(inn)) return false // entered before (15.5.3)
      return true
    }
    // out is a substitute: only his starter comes back (15.5.3), after a rally (15.2.3)
    const s = this.partner.get(out)
    if (s !== inn) return false
    if (this.returned.has(s)) return false
    if (this.rallies <= (this.enteredAtRally.get(out) ?? -1)) return false
    return true
  }

  apply(out, inn) {
    const pos = POS.find(p => this.lineup[p] === out)
    this.ev('substitution', { team: 'home', position: pos, playerOut: out, playerIn: String(inn), isExceptional: false, isExpelled: false, isDisqualified: false })
    this.lineup = { ...this.lineup, [pos]: inn }
    const lu = { team: 'home', lineup: this.str(this.lineup), fromSubstitution: true }
    if (this.libero) lu.liberoSubstitution = { position: this.libero.pos, liberoNumber: LIBERO, playerNumber: this.libero.replaced, liberoType: 'libero1' }
    this.ev('lineup', lu, { sub: true })
    this.regular++
    if (this.starters.has(out)) { this.partner.set(out, inn); this.partner.set(inn, out); this.enteredAtRally.set(inn, this.rallies) } else { this.returned.add(inn); this.subOut.add(out) }
  }

  liberoIn(pos) {
    const replaced = this.lineup[pos]
    this.ev('libero_entry', { team: 'home', position: pos, playerOut: replaced, liberoIn: LIBERO, liberoType: 'libero1' })
    this.lineup = { ...this.lineup, [pos]: LIBERO }
    this.libero = { pos, replaced }
    this.ev('lineup', { team: 'home', lineup: this.str(this.lineup), liberoSubstitution: { position: pos, liberoNumber: LIBERO, playerNumber: replaced, liberoType: 'libero1' } }, { sub: true })
  }

  liberoOut() {
    const { pos, replaced } = this.libero
    this.ev('libero_exit', { team: 'home', position: pos, liberoOut: LIBERO, playerIn: replaced, liberoType: 'libero1' })
    this.lineup = { ...this.lineup, [pos]: replaced }
    this.libero = null
    this.ev('lineup', { team: 'home', lineup: this.str(this.lineup), fromSubstitution: true, liberoSubstitution: null }, { sub: true })
  }

  benchSanction(n, type) {
    this.ev('sanction', { team: 'home', type, playerType: 'bench', playerNumber: n })
    this.sentOff.add(n)
  }
}

const appLegal = (m, out, inn) => {
  const illegal = substitutionIllegalReason(m.events, 1, 'home', { playerOut: out, playerIn: inn }, { players: roster })
  const limit = countRegularSubstitutions(m.events, 'home', 1) >= 6
  // the app's "no completed rally since" is a request warning (Continue anyway):
  // it is the regular substitution's rule (15.2.3) too
  const issues = substitutionRequestIssues(m.events, 1, 'home', { playerOut: out, playerIn: inn }, { players: roster })
  const noRally = issues.some(i => i.reason === 'no_rally_since_entry')
  return { legal: !illegal && !limit && !noRally, illegal, limit, noRally }
}

describe('subs-liberos fuzz: substitutionIllegalReason vs an independent FIVB model', () => {
  it('agrees on every candidate pair along 400 random sets', () => {
    const mismatches = []
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed)
      const m = new Model()
      for (let step = 0; step < 60; step++) {
        const x = r()
        if (x < 0.25) { m.point(); continue }
        if (x < 0.30 && !m.libero) {
          const back = ['I', 'V', 'VI'].filter(p => m.lineup[p] !== LIBERO)
          m.liberoIn(back[Math.floor(r() * back.length)])
          continue
        }
        if (x < 0.34 && m.libero) { m.liberoOut(); continue }
        if (x < 0.36) {
          const benchers = [7, 8, 9, 10, 11].filter(n => !m.onCourt(n) && !m.sentOff.has(n))
          if (benchers.length) m.benchSanction(benchers[Math.floor(r() * benchers.length)], r() < 0.5 ? 'expulsion' : 'disqualification')
          continue
        }
        // check every pair now, then apply a legal one at random
        const court = Object.values(m.lineup)
        const bench = roster.map(p => p.number).filter(n => !court.includes(n))
        const legalPairs = []
        for (const out of court) {
          for (const inn of bench) {
            const model = m.legal(out, inn)
            const app = appLegal(m, out, inn)
            if (model !== app.legal) mismatches.push({ seed, step, out, inn, model, app, history: m.events.filter(e => e.type !== 'lineup').map(e => `${e.type}:${e.payload.playerOut ?? e.payload.playerNumber ?? e.payload.team}>${e.payload.playerIn ?? e.payload.liberoIn ?? ''}`).join(' ') })
            if (model) legalPairs.push([out, inn])
          }
        }
        if (legalPairs.length && r() < 0.6) {
          const [out, inn] = legalPairs[Math.floor(r() * legalPairs.length)]
          m.apply(out, inn)
        }
      }
    }
    if (mismatches.length) console.log(JSON.stringify(mismatches.slice(0, 8), null, 1), '\nmismatches:', mismatches.length)
    expect(mismatches).toEqual([])
  })

  it('validateManualSubstitution (corrections) agrees with the model where the live rule does', () => {
    const mismatches = []
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed * 7)
      const m = new Model()
      for (let step = 0; step < 50; step++) {
        const x = r()
        if (x < 0.3) { m.point(); continue }
        const court = Object.values(m.lineup)
        const bench = roster.map(p => p.number).filter(n => !court.includes(n) && n !== LIBERO)
        const legalPairs = []
        for (const out of court.filter(n => n !== LIBERO)) {
          for (const inn of bench) {
            const model = m.legal(out, inn)
            // the rally rule is the insertion point's, not checked by the manual validator (documented)
            const v = validateManualSubstitution(m.events, 'home', 1, out, inn)
            const modelNoRally = model || (() => {
              // model without the rally condition
              const s = m.partner.get(out)
              return !m.starters.has(out) && s === inn && !m.returned.has(s) && m.regular < 6 && !m.sentOff.has(inn) && m.onCourt(out) && !m.onCourt(inn)
            })()
            if (modelNoRally !== v.legal) mismatches.push({ seed, step, out, inn, model: modelNoRally, app: v })
            if (model) legalPairs.push([out, inn])
          }
        }
        if (legalPairs.length && r() < 0.6) {
          const [out, inn] = legalPairs[Math.floor(r() * legalPairs.length)]
          m.apply(out, inn)
        }
      }
    }
    if (mismatches.length) console.log(JSON.stringify(mismatches.slice(0, 5), null, 1), '\nmismatches:', mismatches.length)
    expect(mismatches).toEqual([])
  })
})

describe('subs-liberos: forced substitutions are classified as the rules say', () => {
  // #3 out for #9, a rally, #9 out and #3 back, a rally: #3's cycle is complete
  const base = () => {
    const m = new Model()
    m.point()
    m.apply(3, 9)
    m.point()
    m.apply(9, 3)
    m.point()
    return m
  }
  it('an injured starter with a complete cycle is substituted exceptionally (15.7)', () => {
    const m = base()
    const verdict = classifyLiveSubstitution(m.events, 1, 'home', { playerOut: 3, playerIn: 10, isInjury: true }, { players: roster })
    expect(verdict).toBe('exceptional')
    const issues = substitutionRequestIssues(m.events, 1, 'home', { playerOut: 3, playerIn: 9, isInjury: true }, { players: roster })
    // #9 is not sent off: he may come in exceptionally
    expect(issues).toEqual([])
    expect(classifyLiveSubstitution(m.events, 1, 'home', { playerOut: 3, playerIn: 9, isInjury: true }, { players: roster })).toBe('exceptional')
  })
  it('a disqualified bench player never comes in, an expelled one not this set', () => {
    const m = base()
    m.benchSanction(10, 'disqualification')
    m.benchSanction(11, 'expulsion')
    expect(isSentOff(m.events, 'home', 10, 1)).toBe(true)
    expect(isSentOff(m.events, 'home', 10, 2)).toBe(true)
    expect(isSentOff(m.events, 'home', 11, 1)).toBe(true)
    expect(isSentOff(m.events, 'home', 11, 2)).toBe(false)
  })
})
