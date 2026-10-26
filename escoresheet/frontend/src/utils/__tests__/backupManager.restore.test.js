import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for the Dexie tables the restore paths touch
function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  let nextId = Math.max(0, ...rows.map(r => r.id)) + 1
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0],
    delete: async () => {
      const ids = [...map.values()].filter(pred).map(r => r.id)
      ids.forEach(id => map.delete(id))
      return ids.length
    }
  })
  return {
    map,
    get: async (id) => map.get(id),
    add: async (row) => {
      const id = row.id ?? nextId++
      if (map.has(id)) throw new Error(`ConstraintError: key ${id} exists`)
      nextId = Math.max(nextId, id + 1)
      map.set(id, { ...row, id })
      return id
    },
    update: async (id, changes) => {
      const row = map.get(id)
      if (!row) return 0
      map.set(id, { ...row, ...changes })
      return 1
    },
    delete: async (id) => { map.delete(id) },
    bulkDelete: async (ids) => { ids.forEach(id => map.delete(id)) },
    clear: async () => { map.clear() },
    toArray: async () => [...map.values()],
    filter: (fn) => collection(fn),
    where: (field) => ({
      equals: (value) => collection(r => r[field] === value),
      anyOf: (...values) => collection(r => values.flat().includes(r[field]))
    })
  }
}

const fakeDb = vi.hoisted(() => ({}))
vi.mock('../../db/db', () => ({ db: fakeDb }))
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))
vi.mock('../../lib/apiClient', () => ({ apiFrom: vi.fn(), apiStorage: { from: vi.fn() } }))

import { restoreMatchFromJson, restoreMatchInPlace, importMatchFromSupabase, serverClosedState, matchBackupFromDatabaseExport, restoreErrorText, BACKUP_FORMAT_ERROR, BACKUP_UNREADABLE_ERROR } from '../backupManager'
import { apiFrom } from '../../lib/apiClient'
import { isStaleClosedCopy } from '../matchReopen'
import { signaturesPayload, signaturesSyncJob } from '../../domain/signatureEdits'
import { approvalSignatureSources, signedOnPhone } from '../../domain/phoneSignature'

const SEED = 'match_100_aaa'
const OTHER = 'match_200_bbb'

function backup(overrides = {}) {
  return {
    version: 1,
    match: { seed_key: SEED, status: 'live', gameN: 7, refereePin: '111111', homeTeamPin: '222222', ...overrides },
    homeTeam: { name: 'Home' },
    awayTeam: { name: 'Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 3, awayPoints: 1 }],
    events: [{ setIndex: 1, type: 'point', seq: 1 }]
  }
}

beforeEach(() => {
  fakeDb.matches = fakeTable([
    { id: 1, seed_key: OTHER, status: 'final' },
    { id: 2, seed_key: SEED, status: 'live' }
  ])
  fakeDb.sets = fakeTable([
    { id: 1, matchId: 1, index: 1 },
    { id: 2, matchId: 2, index: 1 }
  ])
  fakeDb.events = fakeTable([
    { id: 1, matchId: 1, type: 'point' },
    { id: 2, matchId: 2, type: 'point' }
  ])
  fakeDb.teams = fakeTable()
  fakeDb.players = fakeTable()
  fakeDb.sync_queue = fakeTable([
    { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: SEED } },
    { id: 2, resource: 'match', action: 'update', status: 'error', payload: { id: SEED, officials: [{ role: 'r1' }] } },
    { id: 3, resource: 'set', action: 'update', status: 'queued', payload: { external_id: `${SEED}:s:2`, home_points: 4 } },
    { id: 4, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${SEED}:e:2`, match_id: SEED } },
    { id: 5, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${OTHER}:e:1`, match_id: OTHER } },
    { id: 6, resource: 'match', action: 'update', status: 'sent', payload: { id: OTHER, status: 'final' } }
  ])
  fakeDb.transaction = async (...args) => args[args.length - 1]()
})

describe('restoreMatchFromJson', () => {
  it('replaces only this match: other local matches, their rows and jobs stay', async () => {
    const newId = await restoreMatchFromJson(backup())

    // the other match is untouched
    expect(fakeDb.matches.map.get(1)).toMatchObject({ seed_key: OTHER })
    expect(fakeDb.sets.map.get(1)).toMatchObject({ matchId: 1 })
    expect(fakeDb.events.map.get(1)).toMatchObject({ matchId: 1 })
    expect(fakeDb.sync_queue.map.get(5)).toBeDefined()
    expect(fakeDb.sync_queue.map.get(6)).toBeDefined()

    // the old copy of this match is gone, the restored one has a new id
    expect(fakeDb.matches.map.get(2)).toBeUndefined()
    expect(newId).not.toBe(1)
    expect(fakeDb.matches.map.get(newId)).toMatchObject({ seed_key: SEED })
    const restoredSets = [...fakeDb.sets.map.values()].filter(s => s.matchId === newId)
    expect(restoredSets).toHaveLength(2)
    expect([...fakeDb.sets.map.values()].some(s => s.matchId === 2)).toBe(false)

    // this match's old jobs are replaced by one restore job
    for (const id of [1, 2, 3, 4]) expect(fakeDb.sync_queue.map.get(id)).toBeUndefined()
    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    expect(restore.payload.match.external_id).toBe(SEED)
    expect(restore.payload.match.connection_pins).toEqual({ referee: '111111', bench_home: '222222' })
    // cloud set ids follow the new local ids
    expect(restore.payload.sets.map(s => s.external_id)).toEqual(restoredSets.map(s => `${SEED}:s:${s.id}`))
  })

  it('an app backup file (no PINs) keeps the PINs of the local copy it replaces', async () => {
    fakeDb.matches.map.set(2, {
      id: 2, seed_key: SEED, status: 'live', gamePin: '900001', refereePin: '900002', homeTeamPin: '900003',
      awayTeamPin: '900004', homeTeamUploadPin: '900005', awayTeamUploadPin: '900006'
    })
    const app = backup()
    delete app.match.refereePin
    delete app.match.homeTeamPin
    const newId = await restoreMatchFromJson({ ...app, secretsRemoved: true })
    expect(fakeDb.matches.map.get(newId)).toMatchObject({
      gamePin: '900001', refereePin: '900002', homeTeamPin: '900003', awayTeamPin: '900004',
      homeTeamUploadPin: '900005', awayTeamUploadPin: '900006'
    })
    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    expect(restore.payload.match.game_pin).toBe('900001')
    expect(restore.payload.match.connection_pins).toMatchObject({ referee: '900002', bench_home: '900003' })
  })

  it('an app backup file of a match not on this device gets new PINs', async () => {
    const app = backup({ seed_key: 'match_300_ccc' })
    delete app.match.refereePin
    delete app.match.homeTeamPin
    const newId = await restoreMatchFromJson({ ...app, secretsRemoved: true })
    const restored = fakeDb.matches.map.get(newId)
    const pins = ['gamePin', 'refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin'].map(f => restored[f])
    for (const pin of pins) expect(pin).toMatch(/^\d{6}$/)
    expect(new Set(pins).size).toBe(pins.length)
  })

  it('other backups are restored with exactly their own PINs', async () => {
    const newId = await restoreMatchFromJson(backup())
    expect(fakeDb.matches.map.get(newId).gamePin).toBeUndefined()
    expect(fakeDb.matches.map.get(newId).awayTeamPin).toBeUndefined()
  })

  it('never queues a restore for a test match', async () => {
    await restoreMatchFromJson(backup({ test: true }))
    expect([...fakeDb.sync_queue.map.values()].some(j => j.action === 'restore')).toBe(false)
  })
})

describe('restoreMatchInPlace', () => {
  it('keeps pending match insert/update jobs; drops only this match\'s set/event jobs', async () => {
    await restoreMatchInPlace(2, backup())

    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ action: 'insert', status: 'queued' })
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ action: 'update', status: 'error' })
    expect(fakeDb.sync_queue.map.get(3)).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(4)).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(5)).toBeDefined()

    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    // queued after the kept match jobs, so it runs after them
    expect(restore.id).toBeGreaterThan(2)
    expect(restore.payload.match.connection_pins).toEqual({ referee: '111111', bench_home: '222222' })
  })

  it('refuses a backup of another match', async () => {
    await expect(restoreMatchInPlace(2, backup({ seed_key: OTHER }))).rejects.toThrow(/different match/)
  })

  it('omits connection_pins when there are none, instead of sending {}', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED })
    await restoreMatchInPlace(2, backup({ refereePin: undefined, homeTeamPin: undefined }))
    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    expect('connection_pins' in restore.payload.match).toBe(false)
  })
})

describe('remarks (db/017)', () => {
  const REMARKS = 'Actual start time: 18:05\nTeam A, Set 1, Result 3:2: player no. 4 injured'
  const restoreJob = () => [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')

  it('restoreMatchFromJson: the backup\'s remarks are restored here and sent to the server', async () => {
    const newId = await restoreMatchFromJson(backup({ remarks: REMARKS }))
    expect(fakeDb.matches.map.get(newId).remarks).toBe(REMARKS)
    expect(restoreJob().payload.match.remarks).toBe(REMARKS)
  })

  it('restoreMatchInPlace: the same', async () => {
    await restoreMatchInPlace(2, backup({ remarks: REMARKS }))
    expect(fakeDb.matches.map.get(2).remarks).toBe(REMARKS)
    expect(restoreJob().payload.match.remarks).toBe(REMARKS)
  })

  it('a backup without remarks (an app before db/017) does not clear the server\'s', async () => {
    await restoreMatchFromJson(backup())
    expect('remarks' in restoreJob().payload.match).toBe(false)
    fakeDb.sync_queue.map.clear()
    await restoreMatchInPlace(fakeDb.matches.map.size ? [...fakeDb.matches.map.values()].find(m => m.seed_key === SEED).id : 2, backup())
    expect('remarks' in restoreJob().payload.match).toBe(false)
  })

  it('importMatchFromSupabase: the server\'s remarks become the local match\'s', async () => {
    const id = await importMatchFromSupabase({
      match: { external_id: SEED, status: 'live', game_n: 7, home_team: { name: 'H' }, away_team: { name: 'A' }, remarks: REMARKS },
      sets: [],
      events: []
    })
    expect(fakeDb.matches.map.get(id).remarks).toBe(REMARKS)
    const none = await importMatchFromSupabase({ match: { external_id: OTHER, status: 'live' }, sets: [], events: [] })
    expect(fakeDb.matches.map.get(none).remarks).toBe('')
  })
})

// 2026-10-20, game 406970: started on the PC, finished on a phone. The phone's
// copy came from importMatchFromSupabase, which kept only championship_type:
// on the sheet only "Regional" was X'd (owner 2026-10-24)
describe('the match type, gender and level', () => {
  const INFO = {
    hall: 'Kantonsschule Rämibühl Halle G', city: 'Zürich', league: '2L',
    championship_type: 'regional', championship_type_other: '',
    match_type_1: 'championship', match_type_1_other: '',
    match_type_2: 'women', match_type_3: 'senior', match_type_3_other: '', best_of: 5
  }
  const restoreJob = () => [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')

  it('importMatchFromSupabase keeps all of match_info on this device', async () => {
    const id = await importMatchFromSupabase({ match: { external_id: SEED, game_n: 406970, status: 'live', match_info: INFO }, sets: [], events: [] })
    expect(fakeDb.matches.map.get(id)).toMatchObject({
      hall: INFO.hall, city: 'Zürich', league: '2L', championshipType: 'regional',
      match_type_1: 'championship', match_type_2: 'women', match_type_3: 'senior'
    })
  })

  it('a server row without them adds no empty keys, older rows keep their columns', async () => {
    const id = await importMatchFromSupabase({ match: { external_id: SEED, status: 'live', hall: 'Halle', championship_type: 'national' }, sets: [], events: [] })
    const m = fakeDb.matches.map.get(id)
    expect(m).toMatchObject({ hall: 'Halle', championshipType: 'national' })
    expect('match_type_2' in m).toBe(false)
  })

  it('a restore sends every match_info key (the server replaces match_info whole)', async () => {
    await restoreMatchFromJson(backup({ hall: 'H', league: '2L', championshipType: 'regional', match_type_1: 'championship', match_type_2: 'women', match_type_3: 'senior', bestOf: 5 }))
    expect(restoreJob().payload.match.match_info).toEqual({
      hall: 'H', city: '', league: '2L', championship_type: 'regional', championship_type_other: '',
      match_type_1: 'championship', match_type_1_other: '', match_type_2: 'women',
      match_type_3: 'senior', match_type_3_other: '', best_of: 5
    })
  })
})

// 2026-10-20, game 406970: the phone's own copy was refused (OV_GAME_TAKEN)
// and the scorer joined the PC's match with its game PIN
describe('joining a cloud match on this device', () => {
  const OWN = 'match_300_own'
  beforeEach(() => {
    fakeDb.matches = fakeTable([{ id: 1, seed_key: OWN, gameN: 406970, status: 'scheduled', matchInfoConfirmedAt: 'x',
      cloudBlock: { code: 'OV_GAME_TAKEN', claim: { game_n: 406970, mine: true, status: 'live' }, at: 1 } }])
    fakeDb.sync_queue = fakeTable([{ id: 1, resource: 'match', action: 'insert', status: 'failed', payload: { external_id: OWN } }])
  })

  it('a restore by game PIN makes this device the scorer and retires the refused copy of the game', async () => {
    const id = await importMatchFromSupabase({ match: { external_id: SEED, game_n: 406970, status: 'live' }, sets: [], events: [] })
    const claim = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'scorer')
    expect(claim).toMatchObject({ resource: 'match', payload: { id: SEED }, status: 'queued' })
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'final', supersededBy: SEED })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('superseded')
    expect(fakeDb.matches.map.get(id)).toMatchObject({ seed_key: SEED, status: 'live' })
  })

  // review 2026-10-21: a join on a device that still had the match kept two
  // local copies of one match key, the older one with its unsent writes
  it('the cloud copy replaces this device\'s own copy of the match: its rows go, its unsent writes are superseded', async () => {
    fakeDb.matches.map.set(20, { id: 20, seed_key: SEED, status: 'live', cloudBlock: { code: 'OV_SCORER_MOVED' } })
    fakeDb.sets.map.set(7, { id: 7, matchId: 20, index: 1, homePoints: 11, awayPoints: 8 })
    fakeDb.events.map.set(7, { id: 7, matchId: 20, type: 'point' })
    fakeDb.sync_queue.map.set(5, { id: 5, resource: 'set', action: 'update', status: 'failed', payload: { external_id: `${SEED}:s:7`, home_points: 11 } })
    fakeDb.sync_queue.map.set(6, { id: 6, resource: 'event', action: 'insert', status: 'sent', payload: { external_id: `${SEED}:e:7`, match_id: SEED } })
    fakeDb.sync_queue.map.set(8, { id: 8, resource: 'user_match', action: 'upsert', status: 'queued', payload: { match_external_id: SEED } })
    const id = await importMatchFromSupabase({ match: { external_id: SEED, game_n: 7, status: 'live' }, sets: [{ index: 1, home_points: 25, away_points: 20, finished: true }], events: [] })
    const copies = [...fakeDb.matches.map.values()].filter(m => m.seed_key === SEED)
    expect(copies.map(m => m.id)).toEqual([id])
    expect(copies[0].cloudBlock).toBeUndefined()
    expect(id).not.toBe(20)
    expect([...fakeDb.sets.map.values()].filter(s => s.matchId === 20)).toEqual([])
    expect([...fakeDb.events.map.values()].filter(e => e.matchId === 20)).toEqual([])
    expect([...fakeDb.sets.map.values()].filter(s => s.matchId === id && s.homePoints != null)).toMatchObject([{ homePoints: 25, awayPoints: 20 }])
    expect(fakeDb.sync_queue.map.get(5)).toMatchObject({ status: 'superseded', superseded_by: 'cloud-copy' })
    expect(fakeDb.sync_queue.map.get(6).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(8).status).toBe('queued')
    // then this device claims the match
    expect([...fakeDb.sync_queue.map.values()].filter(j => j.action === 'scorer' && j.status === 'queued')).toHaveLength(1)
    // other matches untouched
    expect(fakeDb.matches.map.get(1).seed_key).toBe(OWN)
  })

  it('a backup restore retires it too (its restore job is the take-over), a test match claims nothing', async () => {
    await restoreMatchFromJson(backup({ gameN: 406970 }))
    expect(fakeDb.matches.map.get(1).status).toBe('final')
    expect([...fakeDb.sync_queue.map.values()].some(j => j.action === 'scorer')).toBe(false)
    await importMatchFromSupabase({ match: { external_id: OTHER, game_n: 5, status: 'live', test: true }, sets: [], events: [] })
    expect([...fakeDb.sync_queue.map.values()].some(j => j.action === 'scorer')).toBe(false)
  })
})

// Stress test 2026-10-25 (restore-drops-and-erases-closing-signatures): the
// captains, scorer and referees had signed on the tablet, the tablet died,
// the match was restored on a laptop by game number and Game PIN. The import
// stored the closing signatures under names nothing reads
// (homeCaptainPostGameSignature, refereeSignature) and dropped ref1, ref2 and
// asst_scorer: Match end asked both captains to sign again, and the first
// signature drawn there sent the whole `signatures` object with those slots
// null, which the server stores as is (it replaces the column).
describe('the closing signatures of a match restored by game PIN', () => {
  const SIGNATURES = {
    home_coach: 'data:hc', home_captain: 'data:hk', away_coach: 'data:ac', away_captain: 'data:ak',
    home_captain_post_game: 'data:hp', away_captain_post_game: 'data:ap',
    asst_scorer: 'data:as', scorer: 'data:sc', ref2: 'data:r2', ref1: 'data:r1'
  }
  const restore = (match = {}) => importMatchFromSupabase({
    match: { external_id: SEED, game_n: 7, status: 'ended', coin_toss: { team_a: 'away', team_b: 'home', confirmed: true }, signatures: SIGNATURES, ...match },
    sets: [],
    events: []
  })

  it('every signature is where Match end and the sheet read it', async () => {
    const m = fakeDb.matches.map.get(await restore())
    expect(m).toMatchObject({
      homePostGameCaptainSignature: 'data:hp', awayPostGameCaptainSignature: 'data:ap',
      asstScorerSignature: 'data:as', scorerSignature: 'data:sc', ref2Signature: 'data:r2', ref1Signature: 'data:r1',
      homeCoachSignature: 'data:hc', homeCaptainSignature: 'data:hk', awayCoachSignature: 'data:ac', awayCaptainSignature: 'data:ak'
    })
  })

  it('a signature drawn on the restored copy sends the others back unchanged', async () => {
    const m = fakeDb.matches.map.get(await restore())
    expect(signaturesPayload(m)).toEqual(SIGNATURES)
    const job = signaturesSyncJob({ ...m, homePostGameCaptainSignature: 'data:new' })
    expect(job.payload.signatures).toEqual({ ...SIGNATURES, home_captain_post_game: 'data:new' })
  })

  it('an approved match keeps where each closing signature was made', async () => {
    const approval = {
      approvedAt: '2026-10-25T14:00:00.000Z',
      signatures: {},
      signatureSources: { captainA: 'phone', captainB: 'device', scorer: 'device', asstScorer: null, ref1: 'phone', ref2: 'device' }
    }
    const m = fakeDb.matches.map.get(await restore({ status: 'approved', approval }))
    // Team A is away here: captain A's image is the away captain's
    expect(approvalSignatureSources(m)).toEqual({ captainA: 'phone', captainB: 'device', scorer: 'device', asstScorer: 'device', ref1: 'phone', ref2: 'device' })
    expect(signedOnPhone(m, 'awayPostGameCaptainSignature')).toBe(true)
    expect(signedOnPhone(m, 'homePostGameCaptainSignature')).toBe(false)
  })

  it('a match without signatures restores empty slots, not names nothing reads', async () => {
    const m = fakeDb.matches.map.get(await restore({ signatures: null }))
    for (const field of ['homePostGameCaptainSignature', 'awayPostGameCaptainSignature', 'scorerSignature', 'ref1Signature', 'ref2Signature']) {
      expect(m[field] ?? null).toBeNull()
    }
    for (const legacy of ['homeCaptainPostGameSignature', 'awayCaptainPostGameSignature', 'refereeSignature']) expect(legacy in m).toBe(false)
  })
})

// Stress test 2026-10-25 (setend-backup-not-restorable-silent-restore-errors):
// offline in a browser, the set-end download is the only automatic backup.
// It holds every table of the device ({ exportDate, matchId, matches, ... }),
// and the restore refused anything without `version` and `match`.
describe('a whole-database export (the set-end download)', () => {
  const dump = () => ({
    exportDate: '2026-10-25T18:40:00.000Z',
    exportReason: 'set_1_end',
    matchId: 9,
    matches: [
      { id: 4, seed_key: OTHER, status: 'final', homeTeamId: 1, awayTeamId: 2 },
      { id: 9, seed_key: SEED, status: 'live', gameN: 7, homeTeamId: 3, awayTeamId: 4, refereePin: '111111' }
    ],
    teams: [{ id: 1, name: 'Old home' }, { id: 2, name: 'Old away' }, { id: 3, name: 'Home' }, { id: 4, name: 'Away' }],
    players: [
      { id: 1, teamId: 1, number: 10, lastName: 'Old' },
      { id: 2, teamId: 3, number: 1, lastName: 'Hof' },
      { id: 3, teamId: 4, number: 12, lastName: 'Weg' }
    ],
    sets: [{ id: 1, matchId: 4, index: 1, homePoints: 25, awayPoints: 3, finished: true }, { id: 2, matchId: 9, index: 1, homePoints: 25, awayPoints: 7, finished: true }, { id: 3, matchId: 9, index: 2, homePoints: 2, awayPoints: 3 }],
    events: [{ id: 1, matchId: 4, setIndex: 1, type: 'point', seq: 1 }, { id: 2, matchId: 9, setIndex: 1, type: 'point', seq: 1 }, { id: 3, matchId: 9, setIndex: 2, type: 'point', seq: 2 }],
    referees: [],
    scorers: []
  })

  it('holds the match it was written for, in the backup file shape', () => {
    const b = matchBackupFromDatabaseExport(dump())
    expect(b).toMatchObject({ version: 1, match: { id: 9, seed_key: SEED }, homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' } })
    expect(b.homePlayers.map(p => p.lastName)).toEqual(['Hof'])
    expect(b.awayPlayers.map(p => p.lastName)).toEqual(['Weg'])
    expect(b.sets.map(x => x.id)).toEqual([2, 3])
    expect(b.events.map(x => x.id)).toEqual([2, 3])
    // a backup file, or an export without its match, is not one
    expect(matchBackupFromDatabaseExport(backup())).toBeNull()
    expect(matchBackupFromDatabaseExport({ ...dump(), matchId: 99 })).toBeNull()
    expect(matchBackupFromDatabaseExport(null)).toBeNull()
  })

  it('is restored: that match only, with its sets and events', async () => {
    const id = await restoreMatchFromJson(dump())
    expect(fakeDb.matches.map.get(id)).toMatchObject({ seed_key: SEED, status: 'live', gameN: 7 })
    const sets = [...fakeDb.sets.map.values()].filter(x => x.matchId === id)
    expect(sets.map(x => `${x.index}:${x.homePoints}-${x.awayPoints}`)).toEqual(['1:25-7', '2:2-3'])
    expect([...fakeDb.events.map.values()].filter(x => x.matchId === id)).toHaveLength(2)
    expect(fakeDb.teams.map.get(fakeDb.matches.map.get(id).homeTeamId).name).toBe('Home')
    // the other match of the export is not restored over this device's
    expect([...fakeDb.matches.map.values()].filter(m => m.seed_key === OTHER)).toHaveLength(1)
  })

  it('a file that is not a backup is refused with a code the dialog can say', async () => {
    await expect(restoreMatchFromJson({ hello: 'world' })).rejects.toMatchObject({ code: BACKUP_FORMAT_ERROR })
    await expect(restoreMatchFromJson({ ...dump(), matchId: 99 })).rejects.toMatchObject({ code: BACKUP_FORMAT_ERROR })
  })

  it('restoreErrorText: an unreadable file, a file that is not a backup, anything else', () => {
    const t = (key, opts) => (opts ? `${key} ${JSON.stringify(opts)}` : key)
    expect(restoreErrorText(Object.assign(new Error('x'), { code: BACKUP_UNREADABLE_ERROR }), t)).toBe('settings.backup.restoreErrors.unreadable')
    expect(restoreErrorText(new SyntaxError('Unexpected end of JSON input'), t)).toBe('settings.backup.restoreErrors.unreadable')
    expect(restoreErrorText(Object.assign(new Error('x'), { code: BACKUP_FORMAT_ERROR }), t)).toBe('settings.backup.restoreErrors.notABackup')
    expect(restoreErrorText(new Error('QuotaExceededError'), t)).toBe('settings.backup.restoreErrors.failed {"error":"QuotaExceededError"}')
  })
})

// Stress test 2026-10-25 (restored-sheet-times-and-lfp-differ): every LFP
// mark was gone from the sheet of a copy restored by game PIN
describe('the players of a match restored by game PIN', () => {
  it('keep their LFP flag', async () => {
    const id = await importMatchFromSupabase({
      match: {
        external_id: SEED, game_n: 7, status: 'ended',
        home_team: { name: 'H' }, away_team: { name: 'A' },
        players_home: [{ number: 1, first_name: 'Ana', last_name: 'Hof', is_lfp: true }, { number: 2, first_name: 'Bea', last_name: 'Ris', is_lfp: false }],
        players_away: [{ number: 9, first_name: 'Cleo', last_name: 'Weg', is_lfp: true, is_captain: true }]
      },
      sets: [],
      events: []
    })
    const m = fakeDb.matches.map.get(id)
    const flags = (teamId) => [...fakeDb.players.map.values()].filter(p => p.teamId === teamId).map(p => `${p.number}:${p.isLfp}`)
    expect(flags(m.homeTeamId)).toEqual(['1:true', '2:false'])
    expect(flags(m.awayTeamId)).toEqual(['9:true'])
  })
})

// Stress test 2026-10-25 (restore-reuses-other-matchs-team-by-name): the
// club laptop still held last week's home match. Today's match of the same
// club was restored from a backup: the restore found last week's team row by
// name, overwrote it, replaced its roster with today's and pointed both
// matches at it.
describe('the teams of a restored match', () => {
  const rosterOf = (teamId) => [...fakeDb.players.map.values()].filter(p => p.teamId === teamId).map(p => `${p.number}:${p.lastName}`)
  beforeEach(() => {
    fakeDb.matches.map.get(1).homeTeamId = 3
    fakeDb.matches.map.get(1).awayTeamId = 4
    fakeDb.teams = fakeTable([{ id: 3, name: 'VBC Wiedikon', shortName: 'WIE' }, { id: 4, name: 'Volley 05' }])
    fakeDb.players = fakeTable([
      { id: 1, teamId: 3, number: 10, lastName: 'Baumann' },
      { id: 2, teamId: 3, number: 11, lastName: 'Arnold' },
      { id: 3, teamId: 4, number: 7, lastName: 'Gast' }
    ])
  })

  it('another local match with a team of the same name keeps its team row and roster', async () => {
    const today = backup()
    today.homeTeam = { id: 3, name: 'VBC Wiedikon', shortName: 'VBCW' }
    today.homePlayers = [{ id: 1, teamId: 3, number: 10, lastName: 'Today10' }, { id: 2, teamId: 3, number: 11, lastName: 'Today11' }]
    const id = await restoreMatchFromJson(today)
    const restored = fakeDb.matches.map.get(id)
    expect(restored.homeTeamId).not.toBe(3)
    expect(fakeDb.teams.map.get(restored.homeTeamId)).toMatchObject({ name: 'VBC Wiedikon', shortName: 'VBCW' })
    expect(rosterOf(restored.homeTeamId)).toEqual(['10:Today10', '11:Today11'])
    // last week's match: unchanged
    expect(fakeDb.matches.map.get(1)).toMatchObject({ homeTeamId: 3, awayTeamId: 4 })
    expect(fakeDb.teams.map.get(3)).toMatchObject({ name: 'VBC Wiedikon', shortName: 'WIE' })
    expect(rosterOf(3)).toEqual(['10:Baumann', '11:Arnold'])
    expect(rosterOf(4)).toEqual(['7:Gast'])
  })

  it('the replaced copy of the match takes its own teams and players along, never another match\'s', async () => {
    await fakeDb.teams.add({ id: 5, name: 'Home' })
    await fakeDb.teams.add({ id: 6, name: 'Away' })
    await fakeDb.players.add({ id: 9, teamId: 5, number: 1, lastName: 'Old copy' })
    // the copy shares team 4 with last week's match (an earlier restore did that)
    fakeDb.matches.map.get(2).homeTeamId = 5
    fakeDb.matches.map.get(2).awayTeamId = 4
    const id = await restoreMatchFromJson(backup())
    expect(fakeDb.teams.map.has(5)).toBe(false)
    expect(rosterOf(5)).toEqual([])
    expect(fakeDb.teams.map.get(4)).toMatchObject({ name: 'Volley 05' })
    expect(rosterOf(4)).toEqual(['7:Gast'])
    expect(fakeDb.teams.map.has(6)).toBe(true) // no match of its own, not the copy's
    const restored = fakeDb.matches.map.get(id)
    expect([restored.homeTeamId, restored.awayTeamId].some(t => [3, 4, 5].includes(t))).toBe(false)
  })

  it('restoreMatchInPlace keeps the open match\'s own team rows, not the writing device\'s ids', async () => {
    fakeDb.matches.map.get(2).homeTeamId = 7
    fakeDb.matches.map.get(2).awayTeamId = 8
    await restoreMatchInPlace(2, backup({ homeTeamId: 3, awayTeamId: 4 }))
    expect(fakeDb.matches.map.get(2)).toMatchObject({ homeTeamId: 7, awayTeamId: 8 })
  })
})

// 2026-10-20, match 406970: a backup of a match the server had closed was
// restored as a live copy; its restore job was refused (409 OV_MATCH_CLOSED)
// on every retry and held back every newer write of the match.
describe('restoring a match closed on the server', () => {
  const snapshot = () => ({
    matches: structuredClone([...fakeDb.matches.map.values()]),
    sets: structuredClone([...fakeDb.sets.map.values()]),
    events: structuredClone([...fakeDb.events.map.values()]),
    sync_queue: structuredClone([...fakeDb.sync_queue.map.values()])
  })
  const restoreJobs = () => [...fakeDb.sync_queue.map.values()].filter(j => j.action === 'restore')

  it('the server says closed: refused before anything is replaced or queued', async () => {
    const before = snapshot()
    const checkServer = vi.fn(async () => true)
    const err = await restoreMatchFromJson(backup(), { checkServer }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ code: 'OV_MATCH_CLOSED', externalId: SEED, gameN: 7 })
    expect(checkServer).toHaveBeenCalledWith(SEED)
    expect(snapshot()).toEqual(before)
    expect(restoreJobs()).toEqual([])
  })

  it('the server says open (an admin reopened it): a copy blocked as closed here is restored', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live', cloudBlock: { code: 'OV_MATCH_CLOSED', at: 1 } })
    const newId = await restoreMatchFromJson(backup(), { checkServer: async () => false })
    expect(fakeDb.matches.map.get(2)).toBeUndefined()
    expect(fakeDb.matches.map.get(newId)).toMatchObject({ seed_key: SEED, status: 'live' })
    expect(restoreJobs()).toHaveLength(1)
  })

  it('the server says open: a backup taken after the refusal comes back without its closed evidence (scoring screen, not the closed-copy notice)', async () => {
    const closedBackup = backup({ cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 }, closed_at: '2026-10-20T21:09:00Z' })
    const newId = await restoreMatchFromJson(closedBackup, { checkServer: async () => false })
    const restored = fakeDb.matches.map.get(newId)
    expect(restored).toMatchObject({ seed_key: SEED, status: 'live', cloudBlock: null, closed_at: null })
    expect(isStaleClosedCopy(restored)).toBe(false)
    expect(restoreJobs()).toHaveLength(1)
    // another block is the backup's own
    const moved = { code: 'OV_SCORER_MOVED', claim: null, at: 2 }
    const otherId = await restoreMatchFromJson(backup({ cloudBlock: moved }), { checkServer: async () => false })
    expect(fakeDb.matches.map.get(otherId).cloudBlock).toEqual(moved)
  })

  it('the server cannot be asked: local evidence decides', async () => {
    const offline = async () => null
    // the backup itself is approved
    await expect(restoreMatchFromJson(backup({ status: 'approved' }), { checkServer: offline }))
      .rejects.toMatchObject({ code: 'OV_MATCH_CLOSED' })
    // the local copy it would replace carries the server's closed_at
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live', closed_at: '2026-10-20T21:09:00Z' })
    await expect(restoreMatchFromJson(backup(), { checkServer: offline }))
      .rejects.toMatchObject({ code: 'OV_MATCH_CLOSED' })
    expect(fakeDb.matches.map.get(2)).toMatchObject({ seed_key: SEED, closed_at: '2026-10-20T21:09:00Z' })
    expect(restoreJobs()).toEqual([])
    // nothing says closed: the restore goes ahead
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live' })
    const newId = await restoreMatchFromJson(backup(), { checkServer: offline })
    expect(fakeDb.matches.map.get(newId)).toMatchObject({ seed_key: SEED, status: 'live' })
    expect(restoreJobs()).toHaveLength(1)
  })

  it('a test backup never asks the server', async () => {
    const checkServer = vi.fn(async () => true)
    await restoreMatchFromJson(backup({ test: true, status: 'approved' }), { checkServer })
    await restoreMatchInPlace([...fakeDb.matches.map.values()].find(m => m.seed_key === SEED).id, backup({ test: true }), { checkServer })
    expect(checkServer).not.toHaveBeenCalled()
  })

  it('restoreMatchInPlace: refused before the open match is overwritten', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live', gameN: 7 })
    const before = snapshot()
    const checkServer = vi.fn(async () => true)
    await expect(restoreMatchInPlace(2, backup({ status: 'ended' }), { checkServer }))
      .rejects.toMatchObject({ code: 'OV_MATCH_CLOSED', externalId: SEED, gameN: 7 })
    expect(checkServer).toHaveBeenCalledWith(SEED)
    expect(snapshot()).toEqual(before)
    expect(fakeDb.matches.map.get(2).status).toBe('live')
  })

  it('restoreMatchInPlace: the server cannot be asked and the open copy is known closed', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live', cloudBlock: { code: 'OV_MATCH_CLOSED', at: 1 } })
    await expect(restoreMatchInPlace(2, backup(), { checkServer: async () => null }))
      .rejects.toMatchObject({ code: 'OV_MATCH_CLOSED' })
    await restoreMatchInPlace(2, backup(), { checkServer: async () => false })
    expect(restoreJobs()).toHaveLength(1)
    // the server said open: the current row's block does not survive the merge
    expect(fakeDb.matches.map.get(2)).toMatchObject({ status: 'live', cloudBlock: null })
    expect(isStaleClosedCopy(fakeDb.matches.map.get(2))).toBe(false)
  })

  it('restoreMatchInPlace: the server says open, a backup and a copy that carry closed evidence restore an open copy', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED, status: 'live', closed_at: '2026-10-20T21:09:00Z' })
    await restoreMatchInPlace(2, backup({ cloudBlock: { code: 'OV_MATCH_CLOSED', at: 1 } }), { checkServer: async () => false })
    expect(fakeDb.matches.map.get(2)).toMatchObject({ status: 'live', cloudBlock: null, closed_at: null })
    expect(isStaleClosedCopy(fakeDb.matches.map.get(2))).toBe(false)
    expect(restoreJobs()).toHaveLength(1)
  })

  it('without checkServer the default probe is used; a probe that cannot answer falls back to local evidence', async () => {
    // apiFrom is a bare vi.fn() here: the probe fails and answers null
    const newId = await restoreMatchFromJson(backup())
    expect(fakeDb.matches.map.get(newId)).toMatchObject({ seed_key: SEED })
    await expect(restoreMatchFromJson(backup({ status: 'final' }))).rejects.toMatchObject({ code: 'OV_MATCH_CLOSED' })
  })
})

describe('serverClosedState', () => {
  const answer = (result) => async () => result

  it('closed: a non-test match at approved / final', async () => {
    expect(await serverClosedState(SEED, { read: answer({ data: { external_id: SEED, status: 'approved' }, error: null }) })).toBe(true)
    expect(await serverClosedState(SEED, { read: answer({ data: { external_id: SEED, status: 'final', test: false }, error: null }) })).toBe(true)
    expect(await serverClosedState(SEED, { read: answer({ data: { external_id: SEED, status: 'approved', test: true }, error: null }) })).toBe(false)
    // an admin reopen writes 'ended'
    expect(await serverClosedState(SEED, { read: answer({ data: { external_id: SEED, status: 'ended' }, error: null }) })).toBe(false)
    expect(await serverClosedState(SEED, { read: answer({ data: { external_id: SEED, status: 'live' }, error: null }) })).toBe(false)
  })

  it('a match the server does not have is not closed', async () => {
    expect(await serverClosedState(SEED, { read: answer({ data: null, error: null }) })).toBe(false)
  })

  it('unknown (null): no key, offline, a read error or a failed request', async () => {
    const read = vi.fn(answer({ data: { status: 'approved' }, error: null }))
    expect(await serverClosedState(null, { read })).toBe(null)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      expect(await serverClosedState(SEED, { read })).toBe(null)
    } finally {
      online.mockRestore()
    }
    expect(read).not.toHaveBeenCalled()
    expect(await serverClosedState(SEED, { read: answer({ data: null, error: { message: 'Backend not available' } }) })).toBe(null)
    expect(await serverClosedState(SEED, { read: answer(undefined) })).toBe(null)
    expect(await serverClosedState(SEED, { read: async () => { throw new Error('boom') } })).toBe(null)
    expect(await serverClosedState(SEED, { read: () => { throw new Error('boom') } })).toBe(null)
  })

  it('gives up after 4 s by default: unknown, never a refusal', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const state = serverClosedState(SEED, { read: () => new Promise(() => {}) })
      state.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(3999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await state).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the default read asks for public columns of this match only', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { external_id: SEED, status: 'approved', test: false }, error: null }))
    }
    apiFrom.mockReturnValueOnce(query)
    expect(await serverClosedState(SEED)).toBe(true)
    expect(apiFrom).toHaveBeenCalledWith('matches')
    expect(query.select).toHaveBeenCalledWith('external_id, status, test')
    expect(query.eq).toHaveBeenCalledWith('external_id', SEED)
  })
})
