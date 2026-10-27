// Stress test 2026-10-25 (setend-export-whole-device-db,
// set-end-backup-exports-whole-device): offline, every set end downloaded
// every table of the device, pretty-printed: 89 MB with 30 old matches, 297 MB
// with 100, behind 'Downloading backup...' for 2 to 8 s. The set-end backup
// is now this match only, in the backup file format, and Restore match reads
// it back.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { restoreMatchFromJson } from '../utils/backupManager'
import { offline, online, mountApp, sleep } from './appMount'
import { reloadInto } from './selfCheckFixtures'

const blobs = []
const downloads = []
beforeAll(() => {
  offline()
  URL.createObjectURL = vi.fn((blob) => { blobs.push(blob); return 'blob:test' })
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloads.push(this.download) })
})
afterAll(online)

async function seedPlayers(teamId, prefix) {
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].map(n => ({ teamId, number: n, firstName: prefix, lastName: `${prefix}${n}`, isCaptain: n === 1 })))
}

describe('App: the set-end backup download', () => {
  it('holds this match only, unindented, and restores', async () => {
    // last season's match, still on the device
    const oldHome = await db.teams.add({ name: 'Old home' })
    const oldAway = await db.teams.add({ name: 'Old away' })
    const old = await db.matches.add({ homeTeamId: oldHome, awayTeamId: oldAway, status: 'final', test: true, seed_key: 'old-match' })
    await db.sets.add({ matchId: old, index: 1, homePoints: 25, awayPoints: 3, finished: true })
    await db.events.bulkAdd(Array.from({ length: 50 }, (_, i) => ({ matchId: old, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: i + 1 })))

    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    await seedPlayers(home, 'H')
    await seedPlayers(away, 'A')
    const start = new Date(Date.now() - 3600000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true, createdAt: start, seed_key: 'test-match-now',
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
    })
    // the set point is on the score: the scoreboard asks for the set end
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: false, startTime: start })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: start })

    // the page reloaded on the scoring screen (a fresh start opens Home)
    reloadInto(matchId)
    mountApp()
    const dialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => /won set|Set 1|set end/i.test(d.textContent) && [...d.querySelectorAll('button')].some(b => b.textContent.trim() === 'Confirm'))
    await waitFor(() => expect(dialog()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(() => expect(downloads.some(n => n.startsWith('backup_set1_'))).toBe(true), { timeout: 5000 })
    await sleep(200)

    const text = await blobs.at(-1).text()
    expect(text).not.toMatch(/\n {2}/) // not pretty-printed
    const file = JSON.parse(text)
    expect(file).toMatchObject({ version: 1, match: { id: matchId, seed_key: 'test-match-now' }, homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' } })
    expect(file.matches).toBeUndefined()
    expect(file.events.every(e => e.matchId === matchId)).toBe(true)
    expect(file.homePlayers).toHaveLength(7)

    // what the app wrote, the app restores
    await Promise.all(db.tables.map(table => table.clear()))
    const restored = await restoreMatchFromJson(file)
    expect(await db.matches.get(restored)).toMatchObject({ seed_key: 'test-match-now' })
    expect((await db.sets.where('matchId').equals(restored).toArray()).map(s => `${s.homePoints}-${s.awayPoints}`)).toContain('25-20')
    expect(await db.players.count()).toBe(14)
  }, 20000)
})
