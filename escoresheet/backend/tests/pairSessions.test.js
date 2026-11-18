/**
 * The backend's copy of the Pair a phone core (lib/pairSessions.js, GENERATED
 * from frontend/electron/pairSessionCore.cjs): the shared vectors, with the
 * backend's own SHA-256.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as core from '../lib/pairSessions.js'

const require = createRequire(import.meta.url)
const vectors = require('../../frontend/electron/__fixtures__/pair-vectors.json')
const { runPairVectors } = require('../../frontend/electron/__fixtures__/pairVectorRunner.cjs')

describe('lib/pairSessions.js', () => {
  it('agrees with every shared vector', async () => {
    const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
    assert.deepEqual(await runPairVectors(core, vectors, sha256), [])
  })
})
