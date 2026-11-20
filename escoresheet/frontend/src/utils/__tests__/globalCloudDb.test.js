import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backendConfig', () => ({ getCloudApiUrl: (p) => `https://backend.test${p}` }))
import {
  cloudBundle, cloudSummary, savesToGlobalCloud, saveGlobalCloud, setGlobalShare, deleteGlobalCloud, loadGlobalCloud,
  cloudPageFromUrl, newOrganizerCode, isOrganizerCode, normalizeOrganizerCode, shareUrl, organizerUrl
} from '../globalCloudDb'

const KEY = 'k'.repeat(22)
const match = (over = {}) => ({
  id: 4, global: true, test: false, cloud: true, globalKey: KEY, refereePin: '316271', gamePin: '424242',
  homeTeamPin: '111111', sessionId: 'sess', homeCoachSignature: 'data:image/png;base64,SIG', globalOrganizer: 'ABCDE23456',
  cloudShareToken: null, status: 'live', hall: 'Hall 1', league: 'U18', scheduledAt: '2027-11-05T09:00:00Z', gameN: 3, ...over
})
const data = (over = {}) => ({
  match: match(over),
  homeTeam: { name: 'Bergtal IS', shortName: 'BIS', color: '#1d4ed8' },
  awayTeam: { name: 'Seeblick IS', shortName: 'SIS', color: '#dc2626' },
  homePlayers: [{ firstName: 'Anna', number: 7 }], awayPlayers: [],
  sets: [{ index: 2, homePoints: 10, awayPoints: 8, finished: false }, { index: 1, homePoints: 25, awayPoints: 20, finished: true }],
  events: [{ id: 1, type: 'point', stateSnapshot: { big: true }, stateBefore: {} }]
})
const ok = (payload) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: payload, error: null }) }))

beforeEach(() => localStorage.clear())

describe('globalCloudDb', () => {
  it('takes part only for a Global match with its key and PIN that the scorer switched on', () => {
    expect(savesToGlobalCloud(match())).toBe(true)
    expect(savesToGlobalCloud(match({ cloud: false }))).toBe(false)
    expect(savesToGlobalCloud(match({ global: false }))).toBe(false)
    expect(savesToGlobalCloud(match({ refereePin: null }))).toBe(false)
    expect(savesToGlobalCloud(match({ globalKey: 'short' }))).toBe(false)
  })

  it('the readable copy has no PIN, session id, key, code, share token, signature or undo snapshot', () => {
    const b = cloudBundle(data())
    const text = JSON.stringify(b)
    for (const leak of ['316271', '424242', '111111', 'sess', KEY, 'ABCDE23456', 'SIG', 'stateSnapshot', 'stateBefore']) expect(text.includes(leak), leak).toBe(false)
    expect(b.match.hall).toBe('Hall 1')
    expect(b.homePlayers[0].firstName).toBe('Anna')
    expect(b.events[0].type).toBe('point')
  })

  it('the summary: teams, finished sets in order, sets won, status', () => {
    const s = cloudSummary(data())
    expect(s.home).toEqual({ name: 'Bergtal IS', short: 'BIS', color: '#1d4ed8' })
    expect(s.sets).toEqual([{ home: 25, away: 20 }])
    expect(s.setsWon).toEqual({ home: 1, away: 0 })
    expect(s.status).toBe('live')
    expect(cloudSummary(data({ approved: true })).status).toBe('final')
    expect(s.gameNumber).toBe('3')
  })

  it('saves with key, PIN, bundle, summary and the tournament code; keeps the share token on the match', async () => {
    const fetchImpl = ok({ ok: true, updatedAt: 'x', shareToken: 'T'.repeat(22) })
    const update = vi.fn(async () => 1)
    const r = await saveGlobalCloud(data(), { fetchImpl, database: { matches: { update } } })
    expect(r).toEqual({ ok: true, shareToken: 'T'.repeat(22) })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://backend.test/api/global/cloud/save')
    const body = JSON.parse(init.body)
    expect(body.key).toBe(KEY)
    expect(body.pin).toBe('316271')
    expect(body.organizer).toBe('ABCDE23456')
    expect(body.summary.home.name).toBe('Bergtal IS')
    expect('pdf' in body).toBe(false)
    expect(update).toHaveBeenCalledWith(4, { cloudShareToken: 'T'.repeat(22) })
  })

  it('a match that is off sends nothing; offline sends nothing', async () => {
    const fetchImpl = ok({})
    expect((await saveGlobalCloud(data({ cloud: false }), { fetchImpl })).ok).toBe(false)
    localStorage.setItem('offlineMode', 'true')
    expect((await saveGlobalCloud(data(), { fetchImpl })).reason).toBe('offline')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('share, delete and load go with key and PIN', async () => {
    let fetchImpl = ok({ shareToken: 'S'.repeat(22) })
    expect(await setGlobalShare(match(), true, { fetchImpl })).toEqual({ ok: true, shareToken: 'S'.repeat(22) })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ key: KEY, pin: '316271', on: true })
    fetchImpl = ok({ ok: true })
    expect((await deleteGlobalCloud(match(), { fetchImpl })).ok).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://backend.test/api/global/cloud/delete')
    fetchImpl = ok({ bundle: {}, updatedAt: 'x' })
    expect((await loadGlobalCloud(KEY, '316271', { fetchImpl })).ok).toBe(true)
    expect((await loadGlobalCloud('bad', '1', { fetchImpl })).ok).toBe(false)
  })

  it('codes, links and the livescore page from the URL', () => {
    const c = newOrganizerCode()
    expect(isOrganizerCode(c)).toBe(true)
    expect(normalizeOrganizerCode('abcde-23456')).toBe('ABCDE23456')
    expect(normalizeOrganizerCode('ABCDE2345I')).toBe(null)
    expect(shareUrl('S'.repeat(22))).toBe('https://livescore.openvolley.app/?s=' + 'S'.repeat(22))
    expect(organizerUrl('ABCDE23456')).toBe('https://livescore.openvolley.app/?o=ABCDE23456')
    expect(cloudPageFromUrl('?s=' + 'S'.repeat(22))).toEqual({ share: 'S'.repeat(22) })
    expect(cloudPageFromUrl('?o=abcde23456')).toEqual({ organizer: 'ABCDE23456' })
    expect(cloudPageFromUrl('?s=short')).toBe(null)
    expect(cloudPageFromUrl('')).toBe(null)
  })
})
