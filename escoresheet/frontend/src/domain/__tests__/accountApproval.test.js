import { describe, it, expect } from 'vitest'
import {
  ROLE_TO_SLOT, APPROVAL_ROLES, PIN_RE, isWeakPin, resultKey, resultTriples, approvalFor, isApprovalValid,
  slotComplete, formatApprovalStamp, approvalLine, approvalsBySlot, officialFor, officialName, namesDiffer,
  deviceId, rememberApprovalEmail, recallApprovalEmail, APPROVAL_EMAILS_MAX, pendingSyncJobsFor, approvalSummary,
  approvalsCompletingSlots, approvalsStillValid, normalizeApprovalQuery, changedSets, approvedSheetChanged
} from '../accountApproval'
import { isWeakPin as serverIsWeakPin } from '../../../../backend/lib/approvalPin.js'

const set = (index, homePoints, awayPoints, finished = true) => ({ index, homePoints, awayPoints, finished })
// Spec 1.4 vector
const VECTOR_SETS = [set(1, 25, 20), set(2, 23, 25), set(3, 25, 18), set(4, 25, 22)]
const VECTOR_KEY = 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:25:22'

const record = (over = {}) => ({
  id: '6f1c2a9b-0000-4000-8000-000000000001', short_id: '6F1C2A9B', slot: 'referee1', name: 'Muster Anna',
  approved_at: '2026-10-07T19:42:10.000Z', result_key: VECTOR_KEY, result_matches: true, mine: false, ...over
})

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    dump: () => m
  }
}
const throwingStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') }
}

describe('resultKey (spec 1.4)', () => {
  it('matches the spec vector', () => {
    expect(resultKey(VECTOR_SETS)).toBe(VECTOR_KEY)
  })
  it('sorts by index and leaves out unfinished sets', () => {
    const shuffled = [set(3, 25, 18), set(5, 3, 1, false), set(1, 25, 20), set(4, 25, 22), set(2, 23, 25)]
    expect(resultKey(shuffled)).toBe(VECTOR_KEY)
  })
  it('a missing points value counts as 0; no finished set gives the bare prefix', () => {
    expect(resultKey([{ index: 1, finished: true, homePoints: 25 }])).toBe('ov-result-v1|1:25:0')
    expect(resultKey([])).toBe('ov-result-v1|')
    expect(resultKey(undefined)).toBe('ov-result-v1|')
    expect(resultKey([set(1, 25, 20, false)])).toBe('ov-result-v1|')
  })
  it('resultTriples is the request body shape', () => {
    expect(resultTriples([set(2, 23, 25), set(1, 25, 20)])).toEqual([[1, 25, 20], [2, 23, 25]])
  })
})

describe('slots', () => {
  it('maps the three MatchEnd roles to server slots', () => {
    expect(ROLE_TO_SLOT).toEqual({ ref1: 'referee1', ref2: 'referee2', scorer: 'scorer' })
    expect(APPROVAL_ROLES).toEqual(['scorer', 'ref2', 'ref1'])
  })
  it('approvalFor reads match.accountApprovals by slot; captains and the assistant have none', () => {
    const a = record()
    const match = { accountApprovals: { referee1: a } }
    expect(approvalFor(match, 'ref1')).toBe(a)
    expect(approvalFor(match, 'ref2')).toBeNull()
    expect(approvalFor({ accountApprovals: { scorer: a } }, 'asst-scorer')).toBeNull()
    expect(approvalFor({}, 'ref1')).toBeNull()
  })
  it('approvalsBySlot keys server records and drops revoked or unknown ones', () => {
    const r1 = record()
    const s = record({ slot: 'scorer', id: 'b' })
    expect(approvalsBySlot([r1, s, record({ slot: 'captain' }), record({ slot: 'referee2', revoked_at: 'x' })])).toEqual({ referee1: r1, scorer: s })
    expect(approvalsBySlot(null)).toEqual({})
  })
})

describe('slotComplete', () => {
  const base = { coinTossTeamA: 'home' }
  it('a drawn signature alone completes any slot', () => {
    expect(slotComplete({ ...base, ref1Signature: 'data:x' }, 'ref1', VECTOR_SETS)).toBe(true)
    expect(slotComplete({ ...base, asstScorerSignature: 'data:x' }, 'asst-scorer', VECTOR_SETS)).toBe(true)
    expect(slotComplete({ ...base, homePostGameCaptainSignature: 'data:x' }, 'captain-a', VECTOR_SETS)).toBe(true)
    expect(slotComplete({ coinTossTeamA: 'away', homePostGameCaptainSignature: 'data:x' }, 'captain-b', VECTOR_SETS)).toBe(true)
  })
  it('an account approval alone completes the scorer and the referees', () => {
    const m = { ...base, accountApprovals: { referee1: record(), referee2: record({ slot: 'referee2' }), scorer: record({ slot: 'scorer' }) } }
    expect(slotComplete(m, 'ref1', VECTOR_SETS)).toBe(true)
    expect(slotComplete(m, 'ref2', VECTOR_SETS)).toBe(true)
    expect(slotComplete(m, 'scorer', VECTOR_SETS)).toBe(true)
  })
  it('a stale approval does not', () => {
    const m = { ...base, accountApprovals: { referee1: record() } }
    const changed = [...VECTOR_SETS.slice(0, 3), set(4, 26, 24)]
    expect(isApprovalValid(record(), changed)).toBe(false)
    expect(slotComplete(m, 'ref1', changed)).toBe(false)
  })
  it('both: complete', () => {
    const m = { ...base, ref1Signature: 'data:x', accountApprovals: { referee1: record({ result_key: 'other' }) } }
    expect(slotComplete(m, 'ref1', VECTOR_SETS)).toBe(true)
  })
  it('the assistant scorer and the captains never complete through an approval', () => {
    const m = { ...base, accountApprovals: { scorer: record({ slot: 'scorer' }) } }
    expect(slotComplete(m, 'asst-scorer', VECTOR_SETS)).toBe(false)
    expect(slotComplete(m, 'captain-a', VECTOR_SETS)).toBe(false)
  })
  it('a revoked record never counts', () => {
    expect(isApprovalValid(record({ revoked_at: '2026-10-07T20:00:00Z' }), VECTOR_SETS)).toBe(false)
  })
})

describe('formatApprovalStamp (Europe/Zurich, 24 h)', () => {
  it('summer time (CEST, UTC+2)', () => {
    expect(formatApprovalStamp(record({ approved_at: '2026-07-04T19:42:10.000Z' })))
      .toBe('Approved electronically · Muster Anna · 04.07.2026 21:42 · ID 6F1C2A9B')
  })
  it('winter time (CET, UTC+1), past midnight', () => {
    expect(formatApprovalStamp(record({ approved_at: '2026-01-15T23:05:00.000Z' })))
      .toBe('Approved electronically · Muster Anna · 16.01.2026 00:05 · ID 6F1C2A9B')
  })
  it('another clock on request; empty for no record', () => {
    expect(approvalLine(record({ approved_at: '2026-01-15T23:05:00.000Z' }), { timeZone: 'UTC' })).toBe('Muster Anna · 15.01.2026 23:05 · ID 6F1C2A9B')
    expect(formatApprovalStamp(null)).toBe('')
  })
})

describe('PIN rules (parity with the server table, spec 6.1)', () => {
  it('weak', () => {
    for (const pin of ['0000', '1234', '0123', '9876', '123456', '111111', '4321', '987654']) expect(isWeakPin(pin), pin).toBe(true)
  })
  it('fine', () => {
    for (const pin of ['482917', '8901', '4738', '5821', '529638']) expect(isWeakPin(pin), pin).toBe(false)
  })
  it('weak: common human PINs, years, dates and patterns (review fix)', () => {
    for (const pin of ['1212', '6969', '1122', '1313', '1004', '2000', '2001', '1984', '2580', '1357', '0420', '1123', '121212', '123123', '112233', '150390', '147258']) {
      expect(isWeakPin(pin), pin).toBe(true)
    }
  })
  it('the same answer as the server for every 4 and 5 digit PIN and a spread of 6 digit ones', () => {
    const differ = []
    const check = (pin) => { if (isWeakPin(pin) !== serverIsWeakPin(pin)) differ.push(pin) }
    for (let n = 0; n < 10000; n++) check(String(n).padStart(4, '0'))
    for (let n = 0; n < 100000; n++) check(String(n).padStart(5, '0'))
    for (let n = 0; n < 1000000; n += 7) check(String(n).padStart(6, '0'))
    for (const pin of ['147258', '123123', '112233', '150390', '031590', '900315']) check(pin)
    expect(differ).toEqual([])
  })
  it('PIN_RE takes 4 to 6 digits only', () => {
    for (const bad of ['123', '1234567', '12a4', ' 1234', '']) expect(PIN_RE.test(bad), bad).toBe(false)
    for (const ok of ['1357', '48291', '482917']) expect(PIN_RE.test(ok)).toBe(true)
    expect(isWeakPin(1234)).toBe(false)
  })
})

describe('officials and names', () => {
  const match = { officials: [
    { role: '1st referee', firstName: 'Anna', lastName: 'Muster' },
    { role: '2nd_referee', firstName: 'Ben', lastName: 'Beispiel' },
    { role: 'scorer', firstName: 'Sam', lastName: 'Scorer' },
    { role: 'line judge 1', name: 'Lia Linie' }
  ] }
  it('finds the entry of a role, also under old spellings', () => {
    expect(officialName(officialFor(match, 'ref1'))).toBe('Muster Anna')
    expect(officialName(officialFor(match, 'ref2'))).toBe('Beispiel Ben')
    expect(officialName(officialFor(match, 'scorer'))).toBe('Scorer Sam')
    expect(officialFor(match, 'asst-scorer')).toBeNull()
    expect(officialFor({}, 'ref1')).toBeNull()
  })
  it('namesDiffer ignores case, accents and order', () => {
    expect(namesDiffer('Müller Anna', 'anna muller')).toBe(false)
    expect(namesDiffer('Muster Anna', 'Muster Annabelle')).toBe(true)
    expect(namesDiffer('Muster Anna', '')).toBe(false)
  })
})

describe('device memory', () => {
  it('deviceId is created once and kept', () => {
    const s = memoryStorage()
    const id = deviceId(s)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(deviceId(s)).toBe(id)
  })
  it('deviceId is null when storage throws', () => {
    expect(deviceId(throwingStorage)).toBeNull()
  })
  it('remembers emails per official name, lower-cased, LRU at 50', () => {
    const s = memoryStorage()
    rememberApprovalEmail('Muster Anna', 'Anna@Example.ch', s)
    expect(recallApprovalEmail('  muster   anna ', s)).toBe('anna@example.ch')
    for (let i = 0; i < APPROVAL_EMAILS_MAX; i++) rememberApprovalEmail(`Ref ${i}`, `r${i}@x.ch`, s)
    // Anna was the least recently used: gone; the newest 50 stay
    expect(recallApprovalEmail('Muster Anna', s)).toBe('')
    expect(recallApprovalEmail('Ref 0', s)).toBe('r0@x.ch')
    expect(JSON.parse(s.dump().get('ov.approvalEmails'))).toHaveLength(APPROVAL_EMAILS_MAX)
    // using an entry again moves it to the end
    rememberApprovalEmail('Ref 0', 'r0@x.ch', s)
    rememberApprovalEmail('Ref new', 'new@x.ch', s)
    expect(recallApprovalEmail('Ref 0', s)).toBe('r0@x.ch')
    expect(recallApprovalEmail('Ref 1', s)).toBe('')
  })
  it('the memory never throws when storage does', () => {
    expect(() => rememberApprovalEmail('Muster Anna', 'a@b.ch', throwingStorage)).not.toThrow()
    expect(recallApprovalEmail('Muster Anna', throwingStorage)).toBe('')
  })
})

describe('sync queue and summary', () => {
  it('finds the unsent jobs of this match', () => {
    const seed = 'match_1_abc'
    const jobs = [
      { id: 1, resource: 'set', status: 'queued', payload: { external_id: `${seed}:s:4` } },
      { id: 2, resource: 'event', status: 'sent', payload: { external_id: `${seed}:e:9` } },
      { id: 3, resource: 'match', status: 'sending', payload: { id: seed } },
      { id: 4, resource: 'set', status: 'queued', payload: { external_id: 'match_2_x:s:1' } },
      { id: 5, resource: 'event', status: 'error', payload: { match_id: seed } },
      { id: 6, resource: 'set', status: 'failed', payload: { external_id: `${seed}:s:1` } }
    ]
    expect(pendingSyncJobsFor(jobs, seed).map(j => j.id)).toEqual([1, 3, 5])
  })
  it('the approve job summary has names and ids only, and leaves out stale records', () => {
    const m = { accountApprovals: { referee1: record(), scorer: record({ slot: 'scorer', result_key: 'stale' }) } }
    expect(approvalSummary(m, VECTOR_SETS)).toEqual({
      ref1: { short_id: '6F1C2A9B', name: 'Muster Anna', approved_at: '2026-10-07T19:42:10.000Z' },
      ref2: null,
      scorer: null
    })
  })
})

describe('review fixes: revalidation, the lookup, Manual adjustments', () => {
  const KEY = resultKey(VECTOR_SETS)
  const rec = (slot, over = {}) => ({ id: `${slot}-id`, short_id: 'AAAAAAAA', slot, name: 'N', approved_at: '2026-10-07T19:42:10.000Z', result_key: KEY, result_matches: true, ...over })

  it('only approvals that complete a slot are re-checked: not a stale one, not one under a drawn signature', () => {
    const stale = rec('referee1', { result_key: 'ov-result-v1|1:25:20' })
    const match = { accountApprovals: { referee1: stale, referee2: rec('referee2'), scorer: rec('scorer') }, scorerSignature: 'data:s' }
    expect(approvalsCompletingSlots(match, VECTOR_SETS).map(x => x.role)).toEqual(['ref2'])
    expect(approvalsCompletingSlots(match, VECTOR_SETS, { hasRef2: false })).toEqual([])
    // a stale ref1 record under a drawn ref1 signature: nothing to check, nothing blocks
    const signed = { accountApprovals: { referee1: stale }, ref1Signature: 'data:r1' }
    expect(approvalsCompletingSlots(signed, VECTOR_SETS)).toEqual([])
    expect(approvalsStillValid([], {}, KEY)).toBe(true)
  })

  it('a completing approval stays valid only as the same active server record on the current result', () => {
    const completing = approvalsCompletingSlots({ accountApprovals: { referee1: rec('referee1') } }, VECTOR_SETS)
    expect(approvalsStillValid(completing, { referee1: rec('referee1') }, KEY)).toBe(true)
    expect(approvalsStillValid(completing, {}, KEY)).toBe(false)
    expect(approvalsStillValid(completing, { referee1: rec('referee1', { id: 'other' }) }, KEY)).toBe(false)
    expect(approvalsStillValid(completing, { referee1: rec('referee1', { result_matches: false }) }, KEY)).toBe(false)
    expect(approvalsStillValid(completing, { referee1: rec('referee1') }, 'ov-result-v1|1:25:20')).toBe(false)
  })

  it('normalizeApprovalQuery reads the ID as printed on the PDF', () => {
    expect(normalizeApprovalQuery('ID 6F1C2A9B')).toBe('6F1C2A9B')
    expect(normalizeApprovalQuery(' #6f1c2a9b ')).toBe('6f1c2a9b')
    expect(normalizeApprovalQuery('id: 6F1C2A9B')).toBe('6F1C2A9B')
    expect(normalizeApprovalQuery('#4711')).toBe('4711')
    expect(normalizeApprovalQuery('match_1_abc')).toBe('match_1_abc')
    expect(normalizeApprovalQuery('ID card')).toBe('ID card')
    expect(normalizeApprovalQuery(null)).toBe('')
  })

  it('changedSets: score or finished flag, by id', () => {
    const before = [{ id: 1, ...set(1, 25, 20) }, { id: 2, ...set(2, 25, 23) }, { id: 3, ...set(3, 10, 8, false) }]
    const after = [{ id: 1, ...set(1, 25, 20) }, { id: 2, ...set(2, 25, 22) }, { id: 3, ...set(3, 10, 8, true) }]
    expect(changedSets(before, after).map(s => s.id)).toEqual([2, 3])
    expect(changedSets(before, before)).toEqual([])
  })

  it('approvedSheetChanged: the finished sets or a team name', () => {
    const sets = VECTOR_SETS.map((s, i) => ({ id: i + 1, ...s }))
    const teams = [{ name: 'Home VC' }, { name: 'Away FC' }]
    expect(approvedSheetChanged({ originalSets: sets, editedSets: sets, originalTeams: teams, editedTeams: [{ name: ' home vc ' }, { name: 'Away FC' }] })).toBe(false)
    expect(approvedSheetChanged({ originalSets: sets, editedSets: sets.map(s => (s.index === 2 ? { ...s, awayPoints: 26 } : s)), originalTeams: teams, editedTeams: teams })).toBe(true)
    expect(approvedSheetChanged({ originalSets: sets, editedSets: sets, originalTeams: teams, editedTeams: [teams[1], teams[0]] })).toBe(true)
    // an unfinished set does not count
    expect(approvedSheetChanged({ originalSets: sets, editedSets: [...sets, { id: 9, ...set(5, 3, 1, false) }] })).toBe(false)
  })
})
