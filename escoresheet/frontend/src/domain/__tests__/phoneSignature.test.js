/**
 * Sign on phone, the pure app side (domain/phoneSignature.js,
 * docs/qr-signing-spec.md 5.5, 5.6, 8.5): the relays' stroke rules (shared
 * vectors), fitting and drawing like SignaturePad, the PNG, the context of
 * each slot and the "signed on phone" records.
 */
import { describe, it, expect } from 'vitest'
import vectors from '../../../electron/__fixtures__/sign-vectors.json'
import {
  validateStrokes, fitTransform, drawStrokes, phoneSignatureDataUrl, phoneSignContext, signatureUpdate,
  signatureSource, signedOnPhone, approvalSignatureSources, SLOT_OF_ROLE, PRE_MATCH_SIGNATURE_FIELD, displayWhen
} from '../phoneSignature'

/** A 2D context that records what is done to it. */
function recordingContext() {
  const calls = []
  const props = {}
  const ctx = new Proxy({}, {
    get: (_, k) => (k in props ? props[k] : (...args) => { calls.push([k, ...args]) }),
    set: (_, k, v) => { props[k] = v; calls.push(['set', k, v]); return true },
  })
  return { ctx, calls, props }
}

describe('validateStrokes', () => {
  it('agrees with every shared stroke vector of the relays', () => {
    for (const v of vectors.strokes) {
      const r = validateStrokes(v.pad, v.strokes)
      expect(r.ok, v.name).toBe(!!v.ok)
      if (v.error) expect(r.code, v.name).toBe(v.error)
    }
  })
})

describe('fitTransform', () => {
  const pad = { w: 4000, h: 2000 }
  it('contains and centres with a 4 % margin, keeping the aspect', () => {
    // A wide line: width-bound
    const wide = fitTransform(pad, [[0, 1000, 3840, 1000]])
    expect(wide.scale).toBeCloseTo(600 / (3840 + 320))
    expect(0 * wide.scale + wide.dx).toBeCloseTo(160 * wide.scale)
    expect(1000 * wide.scale + wide.dy).toBeCloseTo(100) // vertically centred
    // A tall one: height-bound, horizontally centred
    const tall = fitTransform(pad, [[2000, 0, 2000, 1680]])
    expect(tall.scale).toBeCloseTo(200 / (1680 + 320))
    expect(2000 * tall.scale + tall.dx).toBeCloseTo(300)
    expect((0 + 1680) / 2 * tall.scale + tall.dy).toBeCloseTo(100)
  })
  it('the same shape anywhere on the pad renders the same', () => {
    const a = fitTransform(pad, [[0, 0, 400, 200]])
    const b = fitTransform(pad, [[3000, 1500, 3400, 1700]])
    expect(a.scale).toBeCloseTo(b.scale)
    expect(0 * a.scale + a.dx).toBeCloseTo(3000 * b.scale + b.dx)
  })
})

describe('drawStrokes', () => {
  it('draws like SignaturePad: black 4 px round pen, moveTo / lineTo, then stroke', () => {
    const { ctx, calls, props } = recordingContext()
    drawStrokes(ctx, { w: 4000, h: 2000 }, [[0, 1000, 300, 1000, 600, 1100], [50, 50]])
    expect(props).toMatchObject({ strokeStyle: '#000000', lineWidth: 4, lineCap: 'round', lineJoin: 'round' })
    const ops = calls.filter((c) => c[0] !== 'set').map((c) => c[0])
    expect(ops).toEqual(['beginPath', 'moveTo', 'lineTo', 'lineTo', 'stroke', 'beginPath', 'arc', 'fill'])
    const arc = calls.find((c) => c[0] === 'arc')
    expect(arc[3]).toBe(2) // a dot: radius = half the pen
  })
})

describe('phoneSignatureDataUrl', () => {
  it('is a 1200 x 400 transparent PNG data URL drawn at scale 2', () => {
    const { ctx, calls } = recordingContext()
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: (type) => `data:${type};base64,AAAA` }
    const url = phoneSignatureDataUrl({ w: 4000, h: 2000 }, [[0, 1000, 300, 1000]], { createCanvas: () => canvas })
    expect(url).toBe('data:image/png;base64,AAAA')
    expect([canvas.width, canvas.height]).toEqual([1200, 400])
    expect(calls.find((c) => c[0] === 'scale')).toEqual(['scale', 2, 2])
    expect(calls.find((c) => c[0] === 'clearRect')).toEqual(['clearRect', 0, 0, 1200, 400])
  })
})

describe('phoneSignContext', () => {
  const match = {
    gameNumber: 4711, scheduledAt: '2026-10-12T18:15:00.000Z', coinTossTeamA: 'away',
    officials: [{ role: 'scorer', firstName: 'Sam', lastName: 'Scorer' }, { role: '1st referee', firstName: 'Anna', lastName: 'Muster' }],
  }
  const base = { match, homeTeam: { name: 'VBC Wiedikon' }, awayTeam: 'Volley 05', homeCaptain: { number: 7, firstName: 'Lea', lastName: 'Muster' }, awayCaptain: { number: 9, firstName: 'Mia', lastName: 'Meier' }, homeCoach: { firstName: 'Cora', lastName: 'Coach' }, lang: 'de-CH' }

  it('captains A / B follow the coin toss', () => {
    expect(phoneSignContext({ ...base, slot: 'captain-a' })).toMatchObject({ teamSide: 'away', teamLabel: 'A', name: '#9 Mia Meier' })
    expect(phoneSignContext({ ...base, slot: 'captain-b' })).toMatchObject({ teamSide: 'home', teamLabel: 'B', name: '#7 Lea Muster' })
  })
  it('pre-match and scoreboard slots name their side, coaches their coach', () => {
    expect(phoneSignContext({ ...base, slot: 'coach-home' })).toMatchObject({ teamSide: 'home', teamLabel: 'B', name: 'Cora Coach' })
    expect(phoneSignContext({ ...base, slot: 'captain-post-away' })).toMatchObject({ teamSide: 'away', teamLabel: 'A', name: '#9 Mia Meier' })
    // Before the toss there is no letter
    const noToss = phoneSignContext({ ...base, match: { ...match, coinTossTeamA: null }, slot: 'captain-home' })
    expect(noToss.teamSide).toBe('home')
    expect(noToss.teamLabel).toBeUndefined()
  })
  it('officials: their name, no team', () => {
    const ctx = phoneSignContext({ ...base, slot: 'ref1' })
    expect(ctx).toEqual({ home: 'VBC Wiedikon', away: 'Volley 05', matchNo: '4711', when: displayWhen(match.scheduledAt), name: 'Anna Muster', lang: 'de-CH' })
    expect(phoneSignContext({ ...base, slot: 'ref2' }).name).toBeUndefined()
  })
  it('falls back to the given team names and drops an unknown language', () => {
    const ctx = phoneSignContext({ match: {}, slot: 'scorer', lang: 'es', fallbackHome: 'Heim', fallbackAway: 'Gast' })
    expect(ctx).toEqual({ home: 'Heim', away: 'Gast' })
  })
  it('every role maps to a slot the relays know', () => {
    for (const slot of Object.values(SLOT_OF_ROLE)) {
      expect(['captain-a', 'captain-b', 'asst-scorer', 'scorer', 'ref2', 'ref1', 'coach-home', 'coach-away', 'captain-home', 'captain-away', 'captain-post-home', 'captain-post-away']).toContain(slot)
    }
    expect(Object.keys(PRE_MATCH_SIGNATURE_FIELD).every((role) => SLOT_OF_ROLE[role])).toBe(true)
  })
})

describe('"signed on phone" records', () => {
  const at = () => '2026-10-07T20:00:00.000Z'
  it('the image and its source go in one update, by key path', () => {
    expect(signatureUpdate('ref1Signature', 'data:x', { source: 'phone', transport: 'lan' }, at)).toEqual({
      ref1Signature: 'data:x',
      'signatureSources.ref1Signature': { via: 'phone', transport: 'lan', at: '2026-10-07T20:00:00.000Z' },
    })
    // Drawn here, or no meta: the record says nothing
    expect(signatureUpdate('ref1Signature', 'data:x', { source: 'device' }, at)['signatureSources.ref1Signature']).toBeNull()
    expect(signatureUpdate('ref1Signature', 'data:x', undefined, at)['signatureSources.ref1Signature']).toBeNull()
    expect(signatureSource(null, { source: 'phone' }, at)).toBeNull()
  })
  it('signedOnPhone and the approval summary', () => {
    const match = {
      coinTossTeamA: 'away',
      homePostGameCaptainSignature: 'data:h', awayPostGameCaptainSignature: 'data:a', scorerSignature: 'data:s', ref1Signature: 'data:r1',
      signatureSources: { awayPostGameCaptainSignature: { via: 'phone', transport: 'cloud' }, scorerSignature: null },
    }
    expect(signedOnPhone(match, 'awayPostGameCaptainSignature')).toBe(true)
    expect(signedOnPhone(match, 'scorerSignature')).toBe(false)
    expect(approvalSignatureSources(match)).toEqual({ captainA: 'phone', captainB: 'device', scorer: 'device', asstScorer: null, ref1: 'device', ref2: null })
  })
})
