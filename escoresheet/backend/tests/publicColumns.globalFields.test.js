/**
 * A Global match's capability fields never leave the relay (audit SEC-28):
 * its tournament code (globalOrganizer: it lists the tournament's matches and
 * PDFs and adds matches to it), its read-only share link (cloudShareToken)
 * and the live screen's court secret (liveSecret). A scorer app up to
 * 26.11.x syncs them in its match row; every PIN holder (referee, either
 * bench) and every PIN-less viewer got them in match-full-data.
 *
 *   cd escoresheet/backend && node --test tests/publicColumns.globalFields.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MATCH_PRIVATE_FIELDS, publicRelayMatch, relayBundleView, relayMatchView, relaySummaryBundle } from '../lib/publicColumns.js'

const SECRETS = { globalKey: 'K'.repeat(22), globalOrganizer: 'ABCDE23456', cloudShareToken: 'A'.repeat(22), liveSecret: 'L'.repeat(22) }
const entry = () => ({
  match: { id: 1, seed_key: 'match_global_1', global: true, cloud: true, status: 'live', coinTossTeamA: 'home', ...SECRETS },
  homeTeam: { name: 'Bergtal IS' },
  awayTeam: { name: 'Seeblick IS' },
  homePlayers: [{ number: 7, lastName: 'Muster' }],
  awayPlayers: [{ number: 4, lastName: 'Beispiel' }],
  sets: [],
  events: []
})

describe('a Global match\'s capability fields (SEC-28)', () => {
  it('are private match fields', () => {
    for (const k of Object.keys(SECRETS)) assert.ok(MATCH_PRIVATE_FIELDS.includes(k), k)
  })

  it('no view of the relay bundle carries them: referee, either bench, a PIN-less socket, the scorer\'s own devices', () => {
    for (const view of ['referee', 'home', 'away', null, 'scorer']) {
      const text = JSON.stringify(relayBundleView(entry(), view))
      for (const [k, v] of Object.entries(SECRETS)) {
        assert.equal(text.includes(v), false, `${view}: ${k}`)
      }
      assert.equal(relayMatchView(entry(), view).global, true, 'the rest of the match row stays')
    }
    const text = JSON.stringify([publicRelayMatch(entry().match), relaySummaryBundle(entry())])
    for (const [k, v] of Object.entries(SECRETS)) assert.equal(text.includes(v), false, k)
  })
})
