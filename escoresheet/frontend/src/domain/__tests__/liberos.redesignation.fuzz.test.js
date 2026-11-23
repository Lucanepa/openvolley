// Property test of the libero re-designation rule (FIVB 19.4.2, Swiss exam
// Q84; owner decision 23.11.2026, audit LOG-04): random sequences of a team's
// liberos becoming unable (injured, declared, disqualified), coming back
// (only when the app allows it, as the scorer's "Able to play again") and
// being re-designated (only when the team has no libero left, the target the
// app picks). Whatever the sequence:
//  - after a re-designation the team never has two acting liberos;
//  - the libero a re-designation replaced never acts again, nor does any
//    original libero once the team re-designated one;
//  - the re-designation replaces the libero who became unable last among
//    those not replaced.
import { describe, it, expect } from 'vitest'
import { liberoPlayState, liberoToReplaceByRedesignation, LIBERO_RECOVERED } from '../liberos'

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

const pick = (r, list) => list[Math.floor(r() * list.length)]

function run(seed) {
  const r = mulberry32(seed)
  const twoLiberos = r() < 0.7
  let players = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(number => ({ number, libero: '' })),
    { number: 11, libero: 'libero1' },
    ...(twoLiberos ? [{ number: 12, libero: 'libero2' }] : [])
  ]
  const originals = new Set(twoLiberos ? [11, 12] : [11])
  const events = []
  let seq = 1
  let set = 1
  const replaced = new Set()
  const lastUnableAt = new Map()
  let redesignated = false
  const ev = (type, payload) => events.push({ seq: seq++, setIndex: set, type, payload: { team: 'home', ...payload } })
  const state = (p) => liberoPlayState(events, 'home', p.number, { setIndex: set, player: p })
  const liberos = () => players.filter(p => p.libero && p.libero !== 'unable')
  const acting = () => liberos().filter(p => !state(p).unable).map(p => p.number)
  const problems = []

  for (let step = 0; step < 40; step++) {
    const x = r()
    const act = acting()
    if (x < 0.1) { set = Math.min(5, set + 1); continue }
    if (x < 0.45 && act.length) {
      const n = pick(r, act)
      const kind = pick(r, ['injury', 'injury', 'declared', 'disqualification'])
      if (kind === 'disqualification') ev('sanction', { type: 'disqualification', playerType: 'libero', playerNumber: n })
      ev('libero_unable', { liberoNumber: n, reason: kind })
      lastUnableAt.set(n, seq - 1)
    } else if (x < 0.65) {
      const back = liberos().filter(p => state(p).mayReturn)
      if (back.length) ev(LIBERO_RECOVERED, { liberoNumber: pick(r, back).number })
    } else if (act.length === 0 && liberos().length > 0) {
      const target = liberoToReplaceByRedesignation(players, events, 'home', { setIndex: set })
      if (!target) continue
      // the latest to become unable among those unable now and not replaced
      const expected = liberos()
        .filter(p => state(p).unable && !state(p).replaced)
        .sort((a, b) => (lastUnableAt.get(b.number) ?? -1) - (lastUnableAt.get(a.number) ?? -1))[0]
      if (expected && expected.number !== target.number) problems.push({ seed, step, why: 'target', target: target.number, expected: expected.number })
      const free = players.filter(p => !p.libero && !events.some(e => e.type === 'libero_redesignation' && e.payload.newLiberoNumber === p.number))
      if (!free.length) continue
      const next = pick(r, free).number
      ev('libero_redesignation', { unableLiberoNumber: target.number, newLiberoNumber: next, reason: 'injury' })
      players = players.map(p => (p.number === target.number ? { ...p, libero: 'unable' } : p.number === next ? { ...p, libero: 'redesignated' } : p))
      replaced.add(target.number)
      redesignated = true
    }
    const now = acting()
    if (redesignated && now.length > 1) problems.push({ seed, step, why: 'two acting liberos', now })
    for (const n of now) {
      if (replaced.has(n)) problems.push({ seed, step, why: 'replaced libero acts', n })
      if (redesignated && originals.has(n)) problems.push({ seed, step, why: 'original libero acts after a re-designation', n })
    }
  }
  return problems
}

describe('libero re-designation: random sequences (Q84)', () => {
  it('never two acting liberos after a re-designation; replaced and original liberos stay out; the latest unable is replaced', () => {
    const problems = []
    for (let seed = 1; seed <= 500; seed++) problems.push(...run(seed))
    expect(problems.slice(0, 5)).toEqual([])
  })
})
