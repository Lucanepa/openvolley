/**
 * Scoreboard displays through the --local relay (backend/server.js): the
 * wire contract every relay runtime passes
 * (tests/helpers/displayPresenceContract.js, docs/scoreboard-display-spec.md).
 */
import { describe, it, before, after } from 'node:test'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { runDisplayPresenceContract } from './helpers/displayPresenceContract.js'

describe('display presence: the --local relay', () => {
  let srv
  before(async () => {
    srv = await bootServer({}, ['--local'])
  })
  after(async () => {
    await srv?.stop()
  })

  it('the shared contract: the scorer told, only the scorer, private-LAN pages only', async () => {
    await runDisplayPresenceContract({ wsUrl: srv.wsUrl, openClient: (url) => openSocket(url), tag: 'node-local' })
  })
})
