/**
 * lib/beachTournaments.js, the pure parts: the beach set rules of a manual
 * result, the URL slug of a title, the ranking CSV (MyBeach order, safe for
 * spreadsheets), and the routing of lib/manageApi.js for /api/beach/*.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setsError, slugify, rankingCsv } from '../lib/beachTournaments.js'
import { createManageApi, manageFamilyOf } from '../lib/manageApi.js'
import { accessFromRoles } from '../lib/access.js'

describe('beachTournaments: pure helpers', () => {
  it('beach sets: 21/21/15, two points clear, best of three', () => {
    assert.equal(setsError([[21, 15], [21, 19]], 1, 'played'), null)
    assert.equal(setsError([[15, 21], [21, 19], [12, 15]], 2, 'played'), null)
    assert.equal(setsError([[28, 26], [30, 32], [16, 14]], 1, 'played'), null)
    assert.match(setsError([[21, 20], [21, 10]], 1, 'played'), /set 1/)
    assert.match(setsError([[25, 21], [21, 10]], 1, 'played'), /set 1/, 'past 21 only two clear')
    assert.match(setsError([[21, 10], [10, 21]], 1, 'played'), /two sets/)
    assert.match(setsError([[21, 10], [21, 10], [15, 10]], 1, 'played'), /over after the second set/)
    assert.match(setsError([[21, 10], [21, 10]], 2, 'played'), /winner/)
    assert.match(setsError(null, 1, 'played'), /required/)
    assert.match(setsError([[21, 10], [21, 10], [15, 10], [1, 0]], 1, 'played'), /at most 3/)
    assert.match(setsError([[21]], 1, 'played'), /two scores/)
    assert.equal(setsError([[25, 23], [25, 20]], 1, 'played', [25, 25, 15]), null, 'other points per draw')
    // retired / forfeit: the sets so far (or none); walkover: none
    assert.equal(setsError([[21, 15], [3, 1]], 1, 'retired'), null)
    assert.equal(setsError(null, 2, 'forfeit'), null)
    assert.equal(setsError(null, 1, 'walkover'), null)
    assert.equal(setsError([], 1, 'walkover'), null)
    assert.match(setsError([[21, 0]], 1, 'walkover'), /no sets/)
  })

  it('slugify', () => {
    assert.equal(slugify('Züri Open 2026'), 'zuri-open-2026')
    assert.equal(slugify('  Coop Beachtour – Bern!  '), 'coop-beachtour-bern')
    assert.equal(slugify('ÉTÉ à Genève'), 'ete-a-geneve')
    assert.equal(slugify('***'), '')
  })

  it('ranking CSV: semicolons, quoted text, no spreadsheet formulas', () => {
    const csv = rankingCsv([
      { final_rank: 1, seed: 2, name: 'Muster/Beispiel', player1: { last: 'Muster', first: 'Anna', licence: 'L1', country: 'SUI' }, player2: { last: 'Beispiel', first: 'Bea', licence: null, country: null } },
      { final_rank: 2, seed: 1, name: '=HYPERLINK("x")', player1: { last: 'A;B', first: '', licence: '', country: '' }, player2: {} }
    ])
    const lines = csv.split('\r\n')
    assert.equal(lines[0].split(';').length, 11)
    assert.equal(lines[1], '1;2;Muster/Beispiel;Muster;Anna;L1;SUI;Beispiel;Bea;;')
    assert.equal(lines[2], `2;1;"'=HYPERLINK(""x"")";"A;B";;;;;;;`)
    assert.ok(csv.endsWith('\r\n'))
  })
})

describe('manageApi: /api/beach/*', () => {
  const routed = []
  const beach = { route: async (args) => { routed.push(args.pathname); return { status: 200, body: { data: 'beach', error: null } } } }
  const api = createManageApi({ accounts: {}, savedTeams: {}, beach })
  const user = { id: '00000000-0000-4000-8000-000000000001' }
  const call = (roles, pathname = '/api/beach/tournaments', method = 'GET') =>
    api.route({ method, pathname, query: new URLSearchParams(), body: {}, user, access: accessFromRoles(roles) })

  it('the family needs a beach right; then lib/beachTournaments.js decides', async () => {
    assert.equal(manageFamilyOf('/api/beach/tournaments'), 'beach')
    assert.equal(manageFamilyOf('/api/beachy'), null)
    for (const roles of [[], ['scorer'], ['competition_manager'], ['referee', 'beach:referee']]) {
      assert.equal((await call(roles)).status, 403, roles.join())
    }
    for (const roles of [['beach:scorer'], ['beach:competition_manager'], ['admin']]) {
      assert.equal((await call(roles)).status, 200, roles.join())
    }
    assert.deepEqual(routed, ['/api/beach/tournaments', '/api/beach/tournaments', '/api/beach/tournaments'])
    const without = createManageApi({ accounts: {}, savedTeams: {} })
    assert.equal((await without.route({ method: 'GET', pathname: '/api/beach/tournaments', user, access: accessFromRoles(['admin']) })).status, 404)
  })
})
