/**
 * The reference clients of the scoreboard feed (tools/scoreboard-client,
 * docs/scoreboard-feed.md) against the --local relay: the Node client over
 * the WebSocket and over HTTP, the Python one over HTTP. Each prints the
 * score line of the match the code names; a wrong code exits 3.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootServer, openSocket } from './helpers/e2eServer.js'

const TOOLS = fileURLToPath(new URL('../../tools/scoreboard-client/', import.meta.url))
const hasPython = spawnSync('python3', ['--version']).status === 0

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: TOOLS, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

describe('scoreboard feed reference clients', () => {
  let srv
  let scorer
  const room = `client-${Date.now().toString(36)}`
  const LINE = 'VBC Musterdorf • 1 | 12 : 9 | 0 Volley Beispiel · set 2 · sets 25:21 · time-outs 1/0 · subs 2/1'
  before(async () => {
    srv = await bootServer({}, ['--local'])
    scorer = await openSocket(srv.wsUrl)
    scorer.send({
      type: 'sync-match-data',
      matchId: 1,
      match: { id: 1, seed_key: room, status: 'live', gameNumber: 7604, gamePin: '615243' },
      homeTeam: { id: 1, name: 'VBC Musterdorf' },
      awayTeam: { id: 2, name: 'Volley Beispiel' },
      homePlayers: [],
      awayPlayers: [],
      sets: [],
      events: [],
      _timestamp: Date.now()
    })
    await scorer.waitFor((m) => m.type === 'display-presence', 5000, 'display-presence')
    scorer.send({ type: 'display-code-set', matchId: room, code: 'QRST4567', issuedAt: Date.now() })
    await scorer.waitFor((m) => m.type === 'display-code-state' && m.active, 5000, 'display-code-state')
    scorer.send({
      type: 'live-state-update',
      matchId: room,
      liveState: {
        team_a_name: 'VBC Musterdorf', team_b_name: 'Volley Beispiel', current_set: 2, points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0,
        serving_team: 'left', side_a: 'left', timeouts_a: 1, timeouts_b: 0, subs_count_a: 2, subs_count_b: 1, match_status: 'live',
        set_results: [{ set: 1, home: 25, away: 21, a: 25, b: 21 }], lineup_a: [{ number: 7 }]
      }
    })
    await new Promise((r) => setTimeout(r, 200))
  })
  after(async () => {
    try { scorer?.ws.terminate() } catch { /* gone */ }
    await srv?.stop()
  })

  it('Node, WebSocket', async () => {
    const r = await run(process.execPath, ['scoreboard-client.mjs', '--code', 'qrst-4567', '--server', srv.base, '--ws', srv.wsUrl, '--once'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out.trim(), LINE)
  })

  it('Node, HTTP polling', async () => {
    const r = await run(process.execPath, ['scoreboard-client.mjs', '--code', 'QRST4567', '--server', srv.base, '--poll', '--once'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out.trim(), LINE)
  })

  it('Node: a wrong code exits 3, no code 2', async () => {
    assert.equal((await run(process.execPath, ['scoreboard-client.mjs', '--code', 'ZZZZZZZZ', '--server', srv.base, '--ws', srv.wsUrl])).code, 3)
    assert.equal((await run(process.execPath, ['scoreboard-client.mjs', '--code', 'ZZZZZZZZ', '--server', srv.base, '--poll'])).code, 3)
    assert.equal((await run(process.execPath, ['scoreboard-client.mjs'])).code, 2)
  })

  it('Python, HTTP polling', { skip: !hasPython && 'no python3' }, async () => {
    const r = await run('python3', ['-I', 'scoreboard_client.py', '--code', 'QRST-4567', '--server', srv.base, '--once'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out.trim(), LINE)
    assert.equal((await run('python3', ['-I', 'scoreboard_client.py', '--code', 'ZZZZZZZZ', '--server', srv.base])).code, 3)
  })
})
