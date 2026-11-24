/**
 * SEC-39: a scoresheet view link (POST /api/scoresheets/:id/view) keeps where
 * its PDF is (the storage key and a digest), not the PDF itself. Before, each
 * of up to VIEW_LINK_MAX links held its whole file (up to 5 MiB) in the
 * backend's memory for VIEW_LINK_TTL_MS: about 250 MB in a 512 MB container
 * (audit PoC poc/uploads_storage/viewlink-memory.mjs). The link reads the file
 * again and opens only the bytes that were read and audited when it was made.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VIEW_LINK_MAX, createScoresheets } from '../lib/scoresheets.js'

const FILE_NAME = `game402397_k${'a'.repeat(32)}.pdf`
const KEY = `2026-10-10/${FILE_NAME}`
const LINK_NAME = 'game402397_1LD_2026-10-10.pdf'

/** The module with one stored PDF of `bytes` (recorded for the match, db/033); its storage counts the reads. */
function sheets (bytes) {
  const m = { id: '11111111-1111-4111-8111-111111111111', game_n: 402397, external_id: 'x', status: 'final', scheduled_at: new Date('2026-10-10T12:30:00Z'), is_beach: false, test: false, league: '1L D', home_name: 'H', away_name: 'A' }
  const stored = { match_id: m.id, path: KEY, stored_at: new Date(1) }
  const pool = { query: async (text) => ({ rows: [/match_scoresheets/.test(text) ? stored : m] }) }
  const files = new Map([[KEY, bytes]])
  const reads = []
  const storage = {
    listFilesTrusted: async () => [{ name: FILE_NAME, mtimeMs: 1 }],
    readTrusted: async ({ path }) => {
      reads.push(path)
      if (!files.has(path)) throw Object.assign(new Error('gone'), { code: 'OV_STORAGE_NOT_FOUND' })
      // a fresh Buffer each time, as the disk read gives
      return Buffer.from(files.get(path))
    }
  }
  const accounts = { audit: async () => {} }
  const s = createScoresheets({ pool, storage, accounts, logger: { warn () {}, error () {} } })
  return { s, m, files, reads }
}
const tokenOf = (path) => path.split('/')[3]

describe('scoresheet view links keep no PDF in memory (SEC-39)', () => {
  it('a link reads its PDF from storage when it is opened, each time', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 - 9, 0x41)])
    const { s, m, reads } = sheets(big)
    const tokens = []
    for (let i = 0; i < VIEW_LINK_MAX; i++) tokens.push(tokenOf((await s.createViewLink({ actorId: 'u1', matchId: m.id })).body.data.path))
    const made = reads.length
    // the link itself holds no copy: opening it reads the file again
    const r = await s.readViewLink({ token: tokens[0], name: LINK_NAME })
    assert.equal(r.status, 200)
    assert.equal(reads.length, made + 1, 'read from storage when opened')
    assert.ok(r.file.data.equals(big))
    assert.equal(r.file.contentType, 'application/pdf')
    assert.equal(r.file.filename, LINK_NAME)
    assert.equal(r.file.disposition, 'inline')
    assert.equal((await s.readViewLink({ token: tokens[0], name: LINK_NAME })).status, 200)
    assert.equal(reads.length, made + 2)
  })

  it('opens only the bytes that were read and audited: a file replaced or removed since is 404', async () => {
    const { s, m, files } = sheets(Buffer.from('%PDF-1.4\n% the approval\n%%EOF\n'))
    const token = tokenOf((await s.createViewLink({ actorId: 'u1', matchId: m.id })).body.data.path)
    assert.equal((await s.readViewLink({ token, name: LINK_NAME })).status, 200)
    files.set(KEY, Buffer.from('%PDF-1.4\n% another file at that place\n%%EOF\n'))
    assert.equal((await s.readViewLink({ token, name: LINK_NAME })).status, 404)
    files.delete(KEY)
    assert.equal((await s.readViewLink({ token, name: LINK_NAME })).status, 404)
  })
})
