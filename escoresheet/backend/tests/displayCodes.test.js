/**
 * The backend's copy of the scoreboard code core (lib/displayCodes.js,
 * GENERATED from frontend/electron/displayCodeCore.cjs): the shared vectors,
 * with the backend's own SHA-256, and the same private live-state columns as
 * lib/publicColumns.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as core from '../lib/displayCodes.js'
import { LIVE_STATE_PRIVATE_COLUMNS } from '../lib/publicColumns.js'

const require = createRequire(import.meta.url)
const vectors = require('../../frontend/electron/__fixtures__/display-code-vectors.json')
const { runDisplayCodeVectors } = require('../../frontend/electron/__fixtures__/displayCodeVectorRunner.cjs')

describe('lib/displayCodes.js', () => {
  it('agrees with every shared vector', () => {
    const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
    assert.deepEqual(runDisplayCodeVectors(core, vectors, sha256), [])
  })

  it('strips the same live-state columns as every other public read', () => {
    assert.deepEqual([...core.LIVE_STATE_PRIVATE_COLUMNS].sort(), [...LIVE_STATE_PRIVATE_COLUMNS].sort())
  })
})
