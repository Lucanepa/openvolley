// The stored players of a team with players who have no shirt number yet
// (db/teamPlayers writeTeamPlayers): saved, matched by id (the number for
// older rows), never dropped nor doubled; a number added later updates the
// same row.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { writeTeamPlayers } from '../teamPlayers'

const rows = async (teamId) => (await db.players.where('teamId').equals(teamId).toArray()).sort((a, b) => a.lastName.localeCompare(b.lastName))
const person = (lastName, number = null, extra = {}) => ({ number, lastName, firstName: 'A', dob: '123456', libero: '', isCaptain: false, isLfp: false, ...extra })

let teamId
beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  teamId = await db.teams.add({ name: 'VC Tornado Adliswil D1' })
})

describe('writeTeamPlayers and players without a shirt number', () => {
  it('stores them with their names, licence, libero and captain', async () => {
    await writeTeamPlayers(teamId, [person('Ammann', null, { isCaptain: true }), person('Bucher', '', { libero: 'libero1' }), person('Christen', 4)])
    expect((await rows(teamId)).map(p => [p.lastName, p.number ?? null, p.dob, p.libero, p.isCaptain])).toEqual([
      ['Ammann', null, '123456', '', true], ['Bucher', null, '123456', 'libero1', false], ['Christen', 4, '123456', '', false]
    ])
  })

  it('keeps them through a save without numbers (matched by id), and a number added later updates the same row', async () => {
    const ids = await writeTeamPlayers(teamId, [person('Ammann'), person('Bucher')])
    const stored = await rows(teamId)
    expect(stored.map(p => p.id).sort()).toEqual([...ids].sort())
    const form = stored.map(p => ({ ...p }))
    // a save of the same numberless roster: nothing dropped, nothing doubled
    await writeTeamPlayers(teamId, form)
    expect((await rows(teamId)).map(p => [p.id, p.lastName, p.number ?? null])).toEqual(stored.map(p => [p.id, p.lastName, null]))
    // the numbers come
    await writeTeamPlayers(teamId, form.map((p, i) => ({ ...p, number: i + 7 })))
    expect((await rows(teamId)).map(p => [p.id, p.lastName, p.number])).toEqual(stored.map((p, i) => [p.id, p.lastName, i + 7]))
  })

  it('matches an older row without an id in the form by its number, adds a new numberless player and removes the one left out', async () => {
    await db.players.bulkAdd([{ teamId, ...person('Alt', 5) }, { teamId, ...person('Weg', 6) }])
    await writeTeamPlayers(teamId, [person('Alt', 5, { firstName: 'Anna' }), person('Neu')])
    expect((await rows(teamId)).map(p => [p.lastName, p.firstName, p.number ?? null])).toEqual([['Alt', 'Anna', 5], ['Neu', 'A', null]])
  })

  it('skips an empty row (no name, no number)', async () => {
    await writeTeamPlayers(teamId, [person('Ammann'), { number: '', lastName: '', firstName: '' }])
    expect((await rows(teamId)).map(p => p.lastName)).toEqual(['Ammann'])
  })
})
