// Tests for lib/storage.js (local-filesystem replacement for Supabase Storage).
// Pure filesystem: runs against a fresh temp directory, no Postgres needed.
//   cd escoresheet/backend && node --test tests/storage.test.js
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createStorage,
  createWriteQuota,
  parseStoragePath,
  normalizeContentType,
  isRateLimitExempt,
  objectId,
  storageOptionsFromEnv,
  maxBodyBytesFor,
  StorageError,
  SENTINEL_NAME,
  TMP_DIR_NAME
} from '../lib/storage.js'

const GiB = 1024 ** 3
const silent = { error() {}, warn() {}, log() {} }
const b64 = (s) => Buffer.from(s).toString('base64')
const plenty = async () => ({ bavail: 100 * GiB / 4096, bsize: 4096 })

let base   // temp dir holding root + an "outside" dir
let root
let outside

async function makeRoot({ sentinel = true } = {}) {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-storage-test-'))
  root = path.join(base, 'storage')
  outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.json'), '{"secret":true}')
  if (sentinel) await fs.writeFile(path.join(root, SENTINEL_NAME), '')
}

function make(opts = {}) {
  return createStorage({ root, statfs: plenty, logger: silent, ...opts })
}

async function exists(p) {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof StorageError, `expected StorageError, got ${e?.stack || e}`)
    assert.equal(e.status, status, `status for ${e.code}: ${e.message}`)
    if (code) assert.equal(e.code, code)
    return true
  })
}

async function walkFiles(dir) {
  const out = []
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...(await walkFiles(full)))
    else out.push(full)
  }
  return out
}

describe('parseStoragePath', () => {
  it('accepts the paths the app writes', () => {
    assert.deepEqual(parseStoragePath('2026-10-05/game12_final.json'), ['2026-10-05', 'game12_final.json'])
    assert.deepEqual(parseStoragePath('backups/backup_g1/backup_g1_set2_scoreleft15_scoreright12_20250104_153045_123.json').length, 3)
    assert.deepEqual(parseStoragePath('logs/game_7/logs.txt'), ['logs', 'game_7', 'logs.txt'])
    assert.deepEqual(parseStoragePath('%2e%2e/x.json'), ['%2e%2e', 'x.json']) // no URL decoding: literal name
  })

  it('rejects traversal, absolute, backslash and empty segments', () => {
    for (const p of ['../x', 'a/../../x', '..', '.', 'a/./b', '/etc/passwd', 'a\\b', '..\\x', 'a//b', 'a/', '', ' /..'.trim(), 'a/..']) {
      assert.equal(parseStoragePath(p), null, JSON.stringify(p))
    }
  })

  it('rejects hidden names (sentinel, temp dir)', () => {
    assert.equal(parseStoragePath(SENTINEL_NAME), null)
    assert.equal(parseStoragePath(`${TMP_DIR_NAME}/x`), null)
    assert.equal(parseStoragePath('a/.hidden.json'), null)
  })

  it('rejects control chars, NUL, bidi and zero-width characters', () => {
    // Literals use \u escapes only: no invisible characters in the source.
    const bad = [
      'a\u0000b', 'a\nb', 'a\u007f', 'a\u0080b', 'a\u0085b', 'a\u009fb', // C0, DEL, C1 (NEL)
      'a\u00adb', 'a\u061cb', 'a\u180eb',                                // soft hyphen, ALM, MVS
      'a\u200bb', 'a\u200fb', '\ufeffa',                                 // zero-width, RLM, BOM
      'a\u2028b', 'a\u2029b',                                            // line / paragraph separator
      'a\u202eb.json', 'a\u2066b', 'a\ufff9b'                            // bidi override, isolate, annotation
    ]
    for (const p of bad) assert.equal(parseStoragePath(p), null, JSON.stringify(p))
  })

  it('rejects unicode look-alikes that normalise to dots or slashes', () => {
    for (const p of ['\uff0e\uff0e/x', '\u2025/x', 'a\uff0fb', '\uff0ehidden', 'a/\u2024x', 'a\uff3cb']) {
      assert.equal(parseStoragePath(p), null, JSON.stringify(p))
    }
  })

  it('rejects slash look-alikes NFKC leaves alone, without leaning on a .. prefix', () => {
    for (const p of ['a\u2215b', 'a\u2044b', 'a\u2216b', 'a\u29f8b', 'a\ufe68b', 'x/a\u2215b.json']) {
      assert.equal(parseStoragePath(p), null, JSON.stringify(p))
    }
  })

  it('rejects Windows-hostile names (ADS colon, reserved devices, trailing dot/space)', () => {
    const bad = [
      'a:b.json', 'x/a:stream', 'C:', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b',
      'CON', 'con.json', 'x/NUL', 'nul.txt', 'Aux', 'prn.pdf', 'COM1', 'com9.json', 'LPT1.txt', 'com\u00b9',
      'a.', 'a ', 'x/b./c.json', 'x/b /c.json'
    ]
    for (const p of bad) assert.equal(parseStoragePath(p), null, JSON.stringify(p))
    // close-but-fine names stay accepted
    for (const p of ['console.json', 'nully/x.json', 'com10.json', 'lpt.txt', 'game 1/logs.txt', 'a.b.json']) {
      assert.ok(parseStoragePath(p), JSON.stringify(p))
    }
  })

  it('rejects lone surrogates, non-strings and oversize input', () => {
    assert.equal(parseStoragePath('a\ud800b'), null)
    assert.equal(parseStoragePath(42), null)
    assert.equal(parseStoragePath({}), null)
    assert.equal(parseStoragePath('a/'.repeat(40) + 'x'), null)
    assert.equal(parseStoragePath('x'.repeat(256)), null)
    assert.equal(parseStoragePath('x'.repeat(1025)), null)
  })

  it('normalises to NFC', () => {
    const nfd = 'cafe\u0301.json'
    assert.deepEqual(parseStoragePath(nfd), ['caf\u00e9.json'])
  })

  it('allowEmpty for list: root and one trailing slash', () => {
    assert.deepEqual(parseStoragePath('', { allowEmpty: true }), [])
    assert.deepEqual(parseStoragePath(undefined, { allowEmpty: true }), [])
    assert.deepEqual(parseStoragePath('backups/', { allowEmpty: true }), ['backups'])
    assert.equal(parseStoragePath('backups//', { allowEmpty: true }), null)
    assert.deepEqual(parseStoragePath('/', { allowEmpty: true }), [])
  })
})

describe('helpers', () => {
  it('normalizeContentType strips parameters and infers from extension', () => {
    assert.equal(normalizeContentType('Text/Plain; charset=utf-8'), 'text/plain')
    assert.equal(normalizeContentType(undefined, 'a.json'), 'application/json')
    assert.equal(normalizeContentType('', 'a.PDF'), 'application/pdf')
    assert.equal(normalizeContentType(undefined, 'a.exe'), 'application/octet-stream')
  })

  it('isRateLimitExempt covers scoresheets {date}/game{n}_final.json only', () => {
    assert.equal(isRateLimitExempt({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json' }), true)
    assert.equal(isRateLimitExempt({ bucket: 'scoresheets', path: '2026-10-05/gameunknown_final.json' }), true)
    assert.equal(isRateLimitExempt({ bucket: 'scoresheets', path: '2026-10-05/game1.pdf' }), false)
    assert.equal(isRateLimitExempt({ bucket: 'scoresheets', path: '2026-10-05/game1.json' }), false)
    assert.equal(isRateLimitExempt({ bucket: 'backup', path: '2026-10-05/game1_final.json' }), false)
    // arbitrary names ending in _final.json are no longer exempt
    for (const p of ['junk/f1_final.json', 'x_final.json', '2026-10-05/a/game1_final.json', '2026-10-05/f_final.json', 'a/2026-10-05/game1_final.json']) {
      assert.equal(isRateLimitExempt({ bucket: 'scoresheets', path: p }), false, p)
    }
  })

  it('objectId is stable and uuid-shaped', () => {
    const id = objectId('backup', 'a/b.json')
    assert.equal(id, objectId('backup', 'a/b.json'))
    assert.notEqual(id, objectId('scoresheets', 'a/b.json'))
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('storageOptionsFromEnv', () => {
    assert.deepEqual(storageOptionsFromEnv({}), { root: '/data/storage' })
    const o = storageOptionsFromEnv({ STORAGE_DIR: '/x', STORAGE_BACKUP_MIN_FREE_MB: '100', STORAGE_SCORESHEETS_MIN_FREE_MB: '0', STORAGE_MAX_FILE_MB: '2', STORAGE_OWNER_SCOPE: 'Prefix' })
    assert.deepEqual(o, { root: '/x', minFreeBytes: { backup: 100 * 1024 * 1024, scoresheets: 0 }, maxFileBytes: 2 * 1024 * 1024, ownerScope: 'prefix' })
    assert.equal(storageOptionsFromEnv({ STORAGE_OWNER_SCOPE: 'off' }).ownerScope, undefined)
    assert.equal(storageOptionsFromEnv({ STORAGE_OWNER_SCOPE: ' ' }).ownerScope, undefined)
  })

  it('storageOptionsFromEnv throws on values it does not understand', () => {
    for (const v of ['on', 'true', 'bogus', '1']) {
      assert.throws(() => storageOptionsFromEnv({ STORAGE_OWNER_SCOPE: v }), /STORAGE_OWNER_SCOPE/, v)
    }
    assert.throws(() => storageOptionsFromEnv({ STORAGE_MAX_FILE_MB: '0' }), /STORAGE_MAX_FILE_MB/)
    assert.throws(() => storageOptionsFromEnv({ STORAGE_MAX_FILE_MB: 'lots' }), /STORAGE_MAX_FILE_MB/)
    assert.throws(() => storageOptionsFromEnv({ STORAGE_BACKUP_MIN_FREE_MB: '-1' }), /STORAGE_BACKUP_MIN_FREE_MB/)
  })

  it('maxBodyBytes leaves room for base64 of a maxFileBytes upload', () => {
    assert.equal(maxBodyBytesFor(3), 4 + 64 * 1024)
    const s = createStorage({ root: '/tmp', maxFileBytes: 6 * 1024 * 1024 })
    assert.equal(s.maxFileBytes, 6 * 1024 * 1024)
    assert.ok(s.maxBodyBytes >= Buffer.alloc(s.maxFileBytes).toString('base64').length + 1024)
    assert.deepEqual(s.bodyTooLarge(), { status: 413, body: { data: null, error: { message: 'File too large', code: 'OV_STORAGE_TOO_LARGE' } } })
  })

  it('createStorage rejects an unknown ownerScope', () => {
    assert.throws(() => createStorage({ root: '/tmp', ownerScope: 'everyone' }), TypeError)
  })
})

describe('storage operations', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('upload then download round-trips and returns the supabase shape', async () => {
    const s = make()
    const res = await s.upload({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json', fileBase64: b64('{"a":1}'), contentType: 'application/json', upsert: true })
    assert.equal(res.path, '2026-10-05/game1_final.json')
    assert.equal(res.fullPath, 'scoresheets/2026-10-05/game1_final.json')
    assert.equal(res.id, objectId('scoresheets', '2026-10-05/game1_final.json'))
    assert.equal(await fs.readFile(path.join(root, 'scoresheets/2026-10-05/game1_final.json'), 'utf8'), '{"a":1}')
    const buf = await s.download({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json' })
    assert.equal(buf.toString(), '{"a":1}')
  })

  it('binary content (PDF) survives byte-for-byte', async () => {
    const s = make()
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
    await s.upload({ bucket: 'scoresheets', path: 'd/game1.pdf', data: bytes, contentType: 'application/pdf' })
    assert.ok((await s.download({ bucket: 'scoresheets', path: 'd/game1.pdf' })).equals(bytes))
  })

  it('upsert defaults to true and replaces atomically; upsert:false refuses an existing object', async () => {
    const s = make()
    const p = 'logs/game_1/logs.txt'
    await s.upload({ bucket: 'backup', path: p, fileBase64: b64('one'), contentType: 'text/plain' })
    await s.upload({ bucket: 'backup', path: p, fileBase64: b64('two'), contentType: 'text/plain' })
    assert.equal((await s.download({ bucket: 'backup', path: p })).toString(), 'two')
    await rejectsWith(s.upload({ bucket: 'backup', path: p, fileBase64: b64('three'), contentType: 'text/plain', upsert: false }), 409, 'OV_STORAGE_EXISTS')
    assert.equal((await s.download({ bucket: 'backup', path: p })).toString(), 'two')
    await s.upload({ bucket: 'backup', path: 'backups/backup_g1/new.json', fileBase64: b64('{}'), contentType: 'application/json', upsert: false })
  })

  it('leaves no temp files behind, on success or failure', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: 'a/b.json', fileBase64: b64('{}'), contentType: 'application/json' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a/b.json', fileBase64: b64('{}'), contentType: 'application/json', upsert: false }), 409)
    assert.deepEqual(await fs.readdir(path.join(root, TMP_DIR_NAME)), [])
  })

  it('concurrent upserts to one path leave one complete version', async () => {
    const s = make()
    const bodies = Array.from({ length: 12 }, (_, i) => JSON.stringify({ i, pad: String(i).repeat(50_000) }))
    await Promise.all(bodies.map((body) => s.upload({ bucket: 'backup', path: 'race/x.json', fileBase64: b64(body), contentType: 'application/json' })))
    const final = (await s.download({ bucket: 'backup', path: 'race/x.json' })).toString()
    assert.ok(bodies.includes(final), 'final content is exactly one of the writes')
    assert.deepEqual(await fs.readdir(path.join(root, TMP_DIR_NAME)), [])
  })

  it('concurrent upsert:false writes: exactly one wins', async () => {
    const s = make()
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      s.upload({ bucket: 'backup', path: 'once/x.json', fileBase64: b64(`{"i":${i}}`), contentType: 'application/json', upsert: false })))
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'OV_STORAGE_EXISTS')
  })

  it('NFD and NFC spellings address the same object', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: 'caf\u00e9/x.json', fileBase64: b64('{"v":1}'), contentType: 'application/json' })
    const buf = await s.download({ bucket: 'backup', path: 'cafe\u0301/x.json' })
    assert.equal(buf.toString(), '{"v":1}')
  })

  it('rejects unknown buckets and malformed bodies', async () => {
    const s = make()
    await rejectsWith(s.upload({ bucket: 'avatars', path: 'a.json', fileBase64: b64('{}'), contentType: 'application/json' }), 400, 'OV_STORAGE_INVALID_BUCKET')
    await rejectsWith(s.upload({ bucket: '../outside', path: 'a.json', fileBase64: b64('{}'), contentType: 'application/json' }), 400, 'OV_STORAGE_INVALID_BUCKET')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a.json', fileBase64: 'not base64!!', contentType: 'application/json' }), 400, 'OV_STORAGE_INVALID_REQUEST')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a.json', fileBase64: 12, contentType: 'application/json' }), 400, 'OV_STORAGE_INVALID_REQUEST')
  })

  it('enforces the content-type allowlist and the size cap', async () => {
    const s = make({ maxFileBytes: 1000 })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a.html', fileBase64: b64('<script>'), contentType: 'text/html' }), 415, 'OV_STORAGE_CONTENT_TYPE')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a.bin', fileBase64: b64('x') }), 415) // inferred octet-stream
    await s.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}') }) // inferred application/json
    await s.upload({ bucket: 'backup', path: 'b.txt', fileBase64: b64('x'), contentType: 'text/plain;charset=UTF-8' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'big.json', data: Buffer.alloc(1001), contentType: 'application/json' }), 413, 'OV_STORAGE_TOO_LARGE')
    assert.equal(await exists(path.join(root, 'backup/big.json')), false)
  })

  it('a folder at the target path is a conflict, a file on the folder path too', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: 'a/b/c.json', fileBase64: b64('{}'), contentType: 'application/json' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a/b', fileBase64: b64('x'), contentType: 'text/plain' }), 409, 'OV_STORAGE_CONFLICT')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'a/b/c.json/d.json', fileBase64: b64('{}'), contentType: 'application/json' }), 409, 'OV_STORAGE_CONFLICT')
  })

  it('download of a missing object or a folder is 404', async () => {
    const s = make()
    await rejectsWith(s.download({ bucket: 'backup', path: 'nope.json' }), 404, 'OV_STORAGE_NOT_FOUND')
    await rejectsWith(s.download({ bucket: 'backup', path: 'no/such/dir.json' }), 404)
    await s.upload({ bucket: 'backup', path: 'dir/x.json', fileBase64: b64('{}'), contentType: 'application/json' })
    await rejectsWith(s.download({ bucket: 'backup', path: 'dir' }), 404)
    await rejectsWith(s.download({ bucket: 'backup', path: 'dir/x.json/y' }), 404)
  })
})

describe('confinement', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  const evil = [
    '../outside/secret.json',
    '../../outside/secret.json',
    'a/../../outside/secret.json',
    '/etc/passwd',
    `${'..'}\\outside\\secret.json`,
    '\uff0e\uff0e/outside/secret.json',
    '\u2025/outside/secret.json',
    '..\u2215outside',
    'x\u2215..\u2215outside',
    'a:b.json',
    `${SENTINEL_NAME}`,
    `${TMP_DIR_NAME}/x.json`,
    'a\u0000/../../x.json'
  ]

  for (const p of evil) {
    it(`refuses ${JSON.stringify(p)} on upload, download and list`, async () => {
      const s = make()
      await rejectsWith(s.upload({ bucket: 'backup', path: p, fileBase64: b64('{}'), contentType: 'application/json' }), 400, 'OV_STORAGE_INVALID_PATH')
      await rejectsWith(s.download({ bucket: 'backup', path: p }), 400, 'OV_STORAGE_INVALID_PATH')
      await rejectsWith(s.list({ bucket: 'backup', path: p }), 400, 'OV_STORAGE_INVALID_PATH')
    })
  }

  it('refuses a symlinked folder inside the bucket (write, read, list)', async () => {
    const s = make()
    await fs.mkdir(path.join(root, 'backup'))
    await fs.symlink(outside, path.join(root, 'backup/link'))
    await rejectsWith(s.upload({ bucket: 'backup', path: 'link/pwn.json', fileBase64: b64('{}'), contentType: 'application/json' }), 403, 'OV_STORAGE_INVALID_PATH')
    await rejectsWith(s.download({ bucket: 'backup', path: 'link/secret.json' }), 403)
    await rejectsWith(s.list({ bucket: 'backup', path: 'link' }), 403)
    assert.equal(await exists(path.join(outside, 'pwn.json')), false)
    // the symlink itself is not listed
    assert.deepEqual((await s.list({ bucket: 'backup', path: '' })).map((e) => e.name), [])
  })

  it('refuses a symlinked file (no read-through, no overwrite of the target)', async () => {
    const s = make()
    await fs.mkdir(path.join(root, 'backup/d'), { recursive: true })
    await fs.symlink(path.join(outside, 'secret.json'), path.join(root, 'backup/d/secret.json'))
    await rejectsWith(s.download({ bucket: 'backup', path: 'd/secret.json' }), 403)
    await rejectsWith(s.upload({ bucket: 'backup', path: 'd/secret.json', fileBase64: b64('{"pwn":1}'), contentType: 'application/json' }), 403)
    assert.equal(await fs.readFile(path.join(outside, 'secret.json'), 'utf8'), '{"secret":true}')
  })

  it('refuses a bucket directory that is itself a symlink', async () => {
    const s = make()
    await fs.symlink(outside, path.join(root, 'backup'))
    await rejectsWith(s.download({ bucket: 'backup', path: 'secret.json' }), 403)
    await rejectsWith(s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}'), contentType: 'application/json' }), 403)
    await rejectsWith(s.list({ bucket: 'backup' }), 403)
  })

  it('a temp dir that is a symlink to elsewhere cannot redirect writes', async () => {
    const s = make()
    await fs.symlink(outside, path.join(root, TMP_DIR_NAME))
    await rejectsWith(s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}'), contentType: 'application/json' }), 403)
    assert.deepEqual((await fs.readdir(outside)).sort(), ['secret.json'])
  })

  it('literal percent-encoded names stay inside the bucket', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: '%2e%2e/x.json', fileBase64: b64('{}'), contentType: 'application/json' })
    assert.equal(await exists(path.join(root, 'backup/%2e%2e/x.json')), true)
  })

  it('every file written lives under {root}/{bucket}', async () => {
    const s = make()
    const paths = ['a.json', 'x/y/z.json', 'caf\u00e9/\u00fc.json', 'game 1/logs.txt']
    for (const p of paths) await s.upload({ bucket: 'backup', path: p, fileBase64: b64('{}') })
    const files = await walkFiles(base)
    for (const f of files) {
      const ok = f.startsWith(path.join(root, 'backup') + path.sep) || f === path.join(root, SENTINEL_NAME) || f === path.join(outside, 'secret.json')
      assert.ok(ok, `unexpected file ${f}`)
    }
  })
})

describe('sentinel and free-space guards', () => {
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('refuses every write when the sentinel is missing (unmounted volume) and creates nothing', async () => {
    await makeRoot({ sentinel: false })
    const s = make()
    await rejectsWith(s.upload({ bucket: 'scoresheets', path: 'd/game1_final.json', fileBase64: b64('{}'), contentType: 'application/json' }), 503, 'OV_STORAGE_UNAVAILABLE')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'd/x.json', fileBase64: b64('{}'), contentType: 'application/json' }), 503)
    await rejectsWith(s.sweep(), 503)
    assert.deepEqual(await fs.readdir(root), [])
    const h = await s.health()
    assert.equal(h.sentinel, false)
    assert.equal(h.storageWritable, false)
  })

  it('a sentinel that is a directory or a symlink does not count', async () => {
    await makeRoot({ sentinel: false })
    await fs.mkdir(path.join(root, SENTINEL_NAME))
    await rejectsWith(make().upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}') }), 503)
    await fs.rmdir(path.join(root, SENTINEL_NAME))
    await fs.writeFile(path.join(outside, 'sent'), '')
    await fs.symlink(path.join(outside, 'sent'), path.join(root, SENTINEL_NAME))
    await rejectsWith(make().upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}') }), 503)
  })

  it('a missing root gives 503 on writes and empty/404 on reads', async () => {
    await makeRoot()
    const s = createStorage({ root: path.join(base, 'not-mounted'), statfs: plenty, logger: silent })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}') }), 503)
    await rejectsWith(s.download({ bucket: 'backup', path: 'x.json' }), 503)
    await rejectsWith(s.list({ bucket: 'backup' }), 503)
    assert.deepEqual(await s.health(), { sentinel: false, storageWritable: false, diskFreeMB: null, lowSpace: null })
  })

  it('reads keep working without the sentinel', async () => {
    await makeRoot()
    const s = make()
    await s.upload({ bucket: 'scoresheets', path: 'd/a.json', fileBase64: b64('{"ok":1}') })
    await fs.rm(path.join(root, SENTINEL_NAME))
    assert.equal((await s.download({ bucket: 'scoresheets', path: 'd/a.json' })).toString(), '{"ok":1}')
  })

  it('refuses backup/ writes below the free-space floor; scoresheets still pass', async () => {
    await makeRoot()
    const free = 1.5 * GiB
    const s = make({ statfs: async () => ({ bavail: free / 4096, bsize: 4096 }) })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'backups/backup_g1/x.json', fileBase64: b64('{}') }), 507, 'OV_STORAGE_LOW_SPACE')
    assert.equal(await exists(path.join(root, 'backup')), false)
    await s.upload({ bucket: 'scoresheets', path: 'd/game1_final.json', fileBase64: b64('{}') })
    const h = await s.health()
    assert.equal(h.diskFreeMB, 1536)
    assert.equal(h.lowSpace, true)
    assert.equal(h.storageWritable, true)
  })

  it('the floor counts the incoming file and is configurable', async () => {
    await makeRoot()
    const free = 2 * GiB + 100
    const s = make({ statfs: async () => ({ bavail: free, bsize: 1 }) })
    await s.upload({ bucket: 'backup', path: 'small.json', data: Buffer.alloc(50), contentType: 'application/json' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'big.json', data: Buffer.alloc(200), contentType: 'application/json' }), 507)
    const s2 = make({ statfs: async () => ({ bavail: 10, bsize: 1 }), minFreeBytes: { backup: 0 } })
    await rejectsWith(s2.upload({ bucket: 'backup', path: 'x.json', data: Buffer.alloc(11), contentType: 'application/json' }), 507)
    await s2.upload({ bucket: 'backup', path: 'x.json', data: Buffer.alloc(10), contentType: 'application/json' })
  })

  it('scoresheets/ has its own smaller floor so the volume never reaches ENOSPC', async () => {
    await makeRoot()
    const MiB = 1024 * 1024
    const s = make({ statfs: async () => ({ bavail: 200 * MiB, bsize: 1 }) })
    await rejectsWith(s.upload({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json', fileBase64: b64('{}') }), 507, 'OV_STORAGE_LOW_SPACE')
    const s2 = make({ statfs: async () => ({ bavail: 300 * MiB, bsize: 1 }) })
    await s2.upload({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json', fileBase64: b64('{}') })
    const s3 = make({ statfs: async () => ({ bavail: 200 * MiB, bsize: 1 }), minFreeBytes: { scoresheets: 0 } })
    await s3.upload({ bucket: 'scoresheets', path: '2026-10-05/game2_final.json', fileBase64: b64('{}') })
  })

  it('statfs failure refuses writes with 503', async () => {
    await makeRoot()
    const s = make({ statfs: async () => { throw new Error('EIO') } })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}') }), 503)
  })

  it('real statfs works on the temp dir', async () => {
    await makeRoot()
    const s = createStorage({ root, logger: silent, minFreeBytes: { backup: 0 } })
    await s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}') })
    const h = await s.health()
    assert.equal(h.sentinel, true)
    assert.ok(h.diskFreeMB > 0)
  })
})

describe('list', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('returns immediate children with supabase fields; folders have id null', async () => {
    const s = make()
    await s.upload({ bucket: 'scoresheets', path: '2026-10-05/game1_final.json', fileBase64: b64('{"a":1}') })
    await s.upload({ bucket: 'scoresheets', path: '2026-10-05/game1.pdf', data: Buffer.alloc(10), contentType: 'application/pdf' })
    await s.upload({ bucket: 'scoresheets', path: '2026-10-04/game2_final.json', fileBase64: b64('{}') })

    const top = await s.list({ bucket: 'scoresheets', path: '' })
    assert.deepEqual(top, [
      { name: '2026-10-04', id: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null },
      { name: '2026-10-05', id: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null }
    ])

    const files = await s.list({ bucket: 'scoresheets', path: '2026-10-05' })
    assert.deepEqual(files.map((f) => f.name), ['game1.pdf', 'game1_final.json'])
    const f = files[1]
    assert.equal(f.id, objectId('scoresheets', '2026-10-05/game1_final.json'))
    assert.equal(f.metadata.size, 7)
    assert.equal(f.metadata.mimetype, 'application/json')
    assert.equal(files[0].metadata.mimetype, 'application/pdf')
    assert.ok(!Number.isNaN(Date.parse(f.created_at)))
    assert.ok(!Number.isNaN(Date.parse(f.updated_at)))
    assert.ok(Date.parse(f.created_at) <= Date.parse(f.updated_at))
    // trailing slash is tolerated
    assert.equal((await s.list({ bucket: 'scoresheets', path: '2026-10-05/' })).length, 2)
  })

  it('created_at survives a migration copy that preserves mtime (rsync -a)', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: 'old/x.json', fileBase64: b64('{}') })
    const then = new Date('2025-01-04T15:30:45.000Z')
    await fs.utimes(path.join(root, 'backup/old/x.json'), then, then)
    const [e] = await s.list({ bucket: 'backup', path: 'old' })
    assert.equal(e.created_at, then.toISOString())
    assert.equal(e.updated_at, then.toISOString())
  })

  it('default limit is 100, limit is capped, offset pages', async () => {
    const s = make()
    const dir = path.join(root, 'backup/backups/backup_g1')
    await fs.mkdir(dir, { recursive: true })
    for (let i = 0; i < 130; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.json`), '{}')
    const first = await s.list({ bucket: 'backup', path: 'backups/backup_g1' })
    assert.equal(first.length, 100)
    assert.equal(first[0].name, 'f000.json')
    const page2 = await s.list({ bucket: 'backup', path: 'backups/backup_g1', options: { limit: 100, offset: 100 } })
    assert.equal(page2.length, 30)
    assert.equal(page2[0].name, 'f100.json')
    assert.equal((await s.list({ bucket: 'backup', path: 'backups/backup_g1', options: { limit: 5000 } })).length, 130)
    assert.equal((await s.list({ bucket: 'backup', path: 'backups/backup_g1', options: { limit: 0 } })).length, 1)
    assert.equal((await s.list({ bucket: 'backup', path: 'backups/backup_g1', options: { limit: 'x', offset: -5 } })).length, 100)
  })

  it('sortBy name desc (as backupManager/logger call it) and by updated_at', async () => {
    const s = make()
    const dir = path.join(root, 'backup/b')
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(path.join(dir, 'sub'))
    const names = ['a.json', 'c.json', 'b.json']
    for (const [i, n] of names.entries()) {
      await fs.writeFile(path.join(dir, n), '{}')
      const t = new Date(Date.UTC(2026, 0, 1 + i))
      await fs.utimes(path.join(dir, n), t, t)
    }
    const desc = await s.list({ bucket: 'backup', path: 'b', options: { sortBy: { column: 'name', order: 'desc' } } })
    assert.deepEqual(desc.map((e) => e.name), ['sub', 'c.json', 'b.json', 'a.json'])
    const byDate = await s.list({ bucket: 'backup', path: 'b', options: { sortBy: { column: 'updated_at', order: 'asc' } } })
    assert.deepEqual(byDate.map((e) => e.name), ['a.json', 'c.json', 'b.json', 'sub']) // folders (null) last on asc
    const byDateDesc = await s.list({ bucket: 'backup', path: 'b', options: { sortBy: { column: 'updated_at', order: 'desc' } } })
    assert.deepEqual(byDateDesc.map((e) => e.name), ['sub', 'b.json', 'c.json', 'a.json'])
    const bogus = await s.list({ bucket: 'backup', path: 'b', options: { sortBy: { column: 'size; drop', order: 'sideways' } } })
    assert.deepEqual(bogus.map((e) => e.name), ['a.json', 'b.json', 'c.json', 'sub'])
  })

  it('search is a case-insensitive prefix match (supabase ILIKE search%)', async () => {
    const s = make()
    for (const n of ['backup_g1_set1.json', 'backup_g1_set2.json', 'other_set1.json']) {
      await s.upload({ bucket: 'backup', path: `x/${n}`, fileBase64: b64('{}') })
    }
    assert.deepEqual((await s.list({ bucket: 'backup', path: 'x', options: { search: 'BACKUP_G1' } })).map((e) => e.name), ['backup_g1_set1.json', 'backup_g1_set2.json'])
    assert.deepEqual(await s.list({ bucket: 'backup', path: 'x', options: { search: 'set1' } }), [])
  })

  it('name-sorted paging with folders and files mixed, both orders', async () => {
    const s = make()
    const dir = path.join(root, 'backup/m')
    await fs.mkdir(dir, { recursive: true })
    for (const n of ['b', 'd']) await fs.mkdir(path.join(dir, n))
    for (const n of ['a.json', 'c.json', 'e.json']) await fs.writeFile(path.join(dir, n), '{}')
    await fs.symlink(outside, path.join(dir, 'f-link'))
    const page = (order, offset, limit) => s.list({ bucket: 'backup', path: 'm', options: { sortBy: { column: 'name', order }, offset, limit } })
    assert.deepEqual((await page('asc', 1, 3)).map((e) => [e.name, e.id === null]), [['b', true], ['c.json', false], ['d', true]])
    assert.deepEqual((await page('desc', 0, 2)).map((e) => e.name), ['e.json', 'd'])
    const [c] = await page('asc', 2, 1)
    assert.equal(c.metadata.size, 2)
  })

  it('missing folder, file path and empty bucket give []', async () => {
    const s = make()
    assert.deepEqual(await s.list({ bucket: 'backup', path: 'backups/backup_g9' }), [])
    assert.deepEqual(await s.list({ bucket: 'backup' }), [])
    await s.upload({ bucket: 'backup', path: 'f.json', fileBase64: b64('{}') })
    assert.deepEqual(await s.list({ bucket: 'backup', path: 'f.json' }), [])
  })

  it('hides dot-entries and temp files', async () => {
    const s = make()
    await s.upload({ bucket: 'backup', path: 'x/a.json', fileBase64: b64('{}') })
    await fs.writeFile(path.join(root, 'backup/x/.emptyFolderPlaceholder'), '')
    assert.deepEqual((await s.list({ bucket: 'backup', path: 'x' })).map((e) => e.name), ['a.json'])
  })
})

describe('quota and owner scoping hooks', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('checkQuota false / {ok:false} refuses with 429 and writes nothing', async () => {
    const calls = []
    const s = make({ checkQuota: (ctx) => { calls.push(ctx); return ctx.size < 5 ? true : { ok: false, message: 'over quota' } } })
    await s.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}'), userId: 'u1' })
    await assert.rejects(s.upload({ bucket: 'backup', path: 'b.json', fileBase64: b64('{"long":1}'), userId: 'u1' }), (e) => e.status === 429 && e.message === 'over quota')
    assert.equal(await exists(path.join(root, 'backup/b.json')), false)
    assert.deepEqual(calls[0], { userId: 'u1', bucket: 'backup', path: 'a.json', size: 2, contentType: 'application/json' })
    const s2 = make({ checkQuota: async () => false })
    await rejectsWith(s2.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}') }), 429, 'OV_STORAGE_QUOTA')
  })

  it('createWriteQuota: per-user window by count and bytes; final scoresheets skip the count only', async () => {
    let t = 0
    const q = createWriteQuota({ windowMs: 1000, maxWrites: 2, maxBytes: 100, now: () => t })
    const w = (userId, size = 1, p = 'x.json', bucket = 'backup') => q({ userId, bucket, path: p, size })
    assert.equal(w('a'), true)
    assert.equal(w('a'), true)
    assert.equal(w('a').ok, false)
    assert.equal(w('b'), true)                                                // separate user
    assert.equal(w('a', 1, '2026-10-05/game1_final.json', 'scoresheets'), true) // exempt from the count
    t = 1000
    assert.equal(w('a'), true)                                                // new window
    assert.equal(w('c', 101).ok, false)                                       // bytes
  })

  it('createWriteQuota: exempt uploads still hit the byte budget (no fill-the-disk bypass)', async () => {
    const q = createWriteQuota({ maxWrites: 2, maxBytes: 10, now: () => 0 })
    const final = (i, size) => q({ userId: 'u', bucket: 'scoresheets', path: `2026-10-05/game${i}_final.json`, size })
    assert.equal(final(1, 6), true)
    assert.equal(final(2, 4), true)
    assert.equal(final(3, 1).ok, false)
    // the reviewer's probe: names merely ending in _final.json are ordinary writes
    let ok = 0
    for (let i = 0; i < 20; i++) if (q({ userId: 'v', bucket: 'scoresheets', path: `junk/f${i}_final.json`, size: 100 }) === true) ok++
    assert.equal(ok, 0)
    // separate budgets: backups cannot starve the final scoresheet
    const q2 = createWriteQuota({ maxWrites: 100, maxBytes: 10, exemptMaxBytes: 50, now: () => 0 })
    assert.equal(q2({ userId: 'u', bucket: 'backup', path: 'b.json', size: 10 }), true)
    assert.equal(q2({ userId: 'u', bucket: 'backup', path: 'c.json', size: 1 }).ok, false)
    assert.equal(q2({ userId: 'u', bucket: 'scoresheets', path: '2026-10-05/game1_final.json', size: 50 }), true)
  })

  it('createWriteQuota end to end; refused writes (409, 403) do not spend quota', async () => {
    const s = make({ checkQuota: createWriteQuota({ maxWrites: 1 }) })
    await s.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}'), userId: 'u' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'b.json', fileBase64: b64('{}'), userId: 'u' }), 429)

    const s2 = make({ checkQuota: createWriteQuota({ maxWrites: 1 }) })
    await s2.upload({ bucket: 'backup', path: 'taken.json', fileBase64: b64('{}'), userId: 'other' })
    await rejectsWith(s2.upload({ bucket: 'backup', path: 'taken.json', fileBase64: b64('{}'), upsert: false, userId: 'u' }), 409)
    await rejectsWith(s2.upload({ bucket: 'backup', path: 'taken.json/x.json', fileBase64: b64('{}'), userId: 'u' }), 409)
    await s2.upload({ bucket: 'backup', path: 'mine.json', fileBase64: b64('{}'), userId: 'u' })
  })

  it("ownerScope 'require': first segment must be the caller's id", async () => {
    const s = make({ ownerScope: 'require' })
    await s.upload({ bucket: 'backup', path: 'u1/a.json', fileBase64: b64('{}'), userId: 'u1' })
    await rejectsWith(s.upload({ bucket: 'backup', path: 'u2/a.json', fileBase64: b64('{}'), userId: 'u1' }), 403, 'OV_STORAGE_FORBIDDEN')
    await rejectsWith(s.upload({ bucket: 'backup', path: 'u1/a.json', fileBase64: b64('{}') }), 403)
    await rejectsWith(s.download({ bucket: 'backup', path: 'u1/a.json', userId: 'u2' }), 403)
    await rejectsWith(s.list({ bucket: 'backup', path: '', userId: 'u1' }), 403)
    assert.equal((await s.list({ bucket: 'backup', path: 'u1', userId: 'u1' })).length, 1)
  })

  it("ownerScope 'prefix': user id is prepended transparently, users are isolated", async () => {
    const s = make({ ownerScope: 'prefix', ownerScopeBuckets: ['backup'] })
    const r = await s.upload({ bucket: 'backup', path: 'backups/x.json', fileBase64: b64('{"u":1}'), userId: 'u1' })
    assert.equal(r.path, 'backups/x.json')
    assert.equal(await exists(path.join(root, 'backup/u1/backups/x.json')), true)
    assert.equal((await s.download({ bucket: 'backup', path: 'backups/x.json', userId: 'u1' })).toString(), '{"u":1}')
    await rejectsWith(s.download({ bucket: 'backup', path: 'backups/x.json', userId: 'u2' }), 404)
    assert.deepEqual((await s.list({ bucket: 'backup', path: 'backups', userId: 'u1' })).map((e) => e.name), ['x.json'])
    assert.deepEqual(await s.list({ bucket: 'backup', path: '', userId: 'u2' }), [])
    await rejectsWith(s.upload({ bucket: 'backup', path: 'x.json', fileBase64: b64('{}'), userId: '../evil' }), 403)
    // scoresheets is not scoped in this configuration
    await s.upload({ bucket: 'scoresheets', path: 'd/game1_final.json', fileBase64: b64('{}'), userId: 'u1' })
    assert.equal(await exists(path.join(root, 'scoresheets/d/game1_final.json')), true)
  })

  it('ownerScope function: may rewrite or deny; its output is re-validated', async () => {
    const seen = []
    const s = make({
      ownerScope: ({ op, userId, bucket, path: p }) => {
        seen.push(op)
        if (p.startsWith('deny')) return null
        if (p.startsWith('evil')) return '../outside/secret.json'
        return `team-${userId}/${p}`
      }
    })
    await s.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}'), userId: 'u1' })
    assert.equal(await exists(path.join(root, 'backup/team-u1/a.json')), true)
    await rejectsWith(s.upload({ bucket: 'backup', path: 'deny.json', fileBase64: b64('{}'), userId: 'u1' }), 403)
    await rejectsWith(s.download({ bucket: 'backup', path: 'evil.json', userId: 'u1' }), 403)
    await s.list({ bucket: 'backup', path: '', userId: 'u1' })
    assert.deepEqual([...new Set(seen)].sort(), ['list', 'read', 'write'])
  })

  it('ownerScope predicate returning true allows the path unchanged (no object named "true")', async () => {
    const s = make({ ownerScope: async () => true })
    const r = await s.upload({ bucket: 'backup', path: 'a/b.json', fileBase64: b64('{"x":1}'), userId: 'u1' })
    assert.equal(r.path, 'a/b.json')
    assert.equal(await exists(path.join(root, 'backup/a/b.json')), true)
    assert.equal(await exists(path.join(root, 'backup/true')), false)
    assert.equal((await s.download({ bucket: 'backup', path: 'a/b.json', userId: 'u1' })).toString(), '{"x":1}')
    assert.deepEqual((await s.list({ bucket: 'backup', path: 'a', userId: 'u1' })).map((e) => e.name), ['b.json'])
  })

  it('ownerScope returning a non-string, non-true value is forbidden', async () => {
    for (const out of [{}, { path: 'a.json' }, 1, 0, '', [], ['a.json'], Symbol('x'), 1n]) {
      const s = make({ ownerScope: () => out })
      await rejectsWith(s.upload({ bucket: 'backup', path: 'a.json', fileBase64: b64('{}'), userId: 'u1' }), 403, 'OV_STORAGE_FORBIDDEN')
      await rejectsWith(s.download({ bucket: 'backup', path: 'a.json', userId: 'u1' }), 403)
    }
    assert.deepEqual(await fs.readdir(root), [SENTINEL_NAME])
  })
})

describe('sweep', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('deletes old backups, keeps new ones and other prefixes, never follows symlinks', async () => {
    const now = Date.UTC(2026, 9, 5)
    const s = make({ now: () => now })
    const old = new Date(now - 31 * 24 * 3600 * 1000)
    await s.upload({ bucket: 'backup', path: 'backups/backup_g1/old.json', fileBase64: b64('{}') })
    await s.upload({ bucket: 'backup', path: 'backups/backup_g1/new.json', fileBase64: b64('{}') })
    await s.upload({ bucket: 'backup', path: 'backups/backup_g2/old.json', fileBase64: b64('{}') })
    await s.upload({ bucket: 'backup', path: 'logs/game_1/logs.txt', fileBase64: b64('x') })
    for (const p of ['backups/backup_g1/old.json', 'backups/backup_g2/old.json', 'logs/game_1/logs.txt']) {
      await fs.utimes(path.join(root, 'backup', p), old, old)
    }
    await fs.utimes(path.join(outside, 'secret.json'), old, old)
    await fs.symlink(outside, path.join(root, 'backup/backups/link'))
    await fs.writeFile(path.join(root, TMP_DIR_NAME, 'stale.part'), 'x')
    await fs.utimes(path.join(root, TMP_DIR_NAME, 'stale.part'), old, old)
    // folders last touched long ago are eligible for removal once emptied
    for (const d of ['backups/backup_g1', 'backups/backup_g2']) await fs.utimes(path.join(root, 'backup', d), old, old)

    const r = await s.sweep()
    assert.deepEqual(r, { deletedFiles: 2, deletedBytes: 4, removedDirs: 1, tmpRemoved: 1 })
    assert.equal(await exists(path.join(root, 'backup/backups/backup_g1/new.json')), true)
    assert.equal(await exists(path.join(root, 'backup/backups/backup_g2')), false)
    assert.equal(await exists(path.join(root, 'backup/logs/game_1/logs.txt')), true)
    assert.equal(await exists(path.join(outside, 'secret.json')), true)
    assert.equal(await exists(path.join(root, 'backup/backups')), true)
  })

  it('keeps a freshly created empty folder (an upload may be about to rename into it)', async () => {
    const s = make() // real clock
    await fs.mkdir(path.join(root, 'backup/backups/backup_g7'), { recursive: true })
    const r = await s.sweep()
    assert.equal(r.removedDirs, 0)
    assert.equal(await exists(path.join(root, 'backup/backups/backup_g7')), true)
    // once it is older than the grace period it goes
    const old = new Date(Date.now() - 10 * 60 * 1000)
    await fs.utimes(path.join(root, 'backup/backups/backup_g7'), old, old)
    assert.equal((await s.sweep()).removedDirs, 1)
  })

  it('an upload whose folder is removed before the rename recreates it and succeeds', async () => {
    let removed = false
    const s = make({
      // runs after resolve() created backup/backups/backup_g5 and before the rename
      checkQuota: async () => {
        await fs.rmdir(path.join(root, 'backup/backups/backup_g5'))
        removed = true
        return true
      }
    })
    for (const upsert of [true, false]) {
      removed = false
      const p = `backups/backup_g5/x_${upsert}.json`
      await s.upload({ bucket: 'backup', path: p, fileBase64: b64('{"ok":1}'), upsert })
      assert.equal(removed, true)
      assert.equal((await s.download({ bucket: 'backup', path: p })).toString(), '{"ok":1}')
      await fs.rm(path.join(root, 'backup/backups/backup_g5', `x_${upsert}.json`))
    }
    assert.deepEqual(await fs.readdir(path.join(root, TMP_DIR_NAME)), [])
  })

  it('missing prefix is a no-op', async () => {
    const s = make()
    assert.deepEqual(await s.sweep(), { deletedFiles: 0, deletedBytes: 0, removedDirs: 0, tmpRemoved: 0 })
  })
})

describe('handle (HTTP adapter)', () => {
  beforeEach(async () => makeRoot())
  afterEach(async () => fs.rm(base, { recursive: true, force: true }))

  it('upload / download / list in the apiClient wire format', async () => {
    const s = make()
    const up = await s.handle('upload', { bucket: 'backup', path: 'backups/backup_g1/x.json', fileBase64: b64('{"a":1}'), contentType: 'application/json', upsert: false }, { userId: 'u1' })
    assert.equal(up.status, 200)
    assert.deepEqual(Object.keys(up.body), ['data', 'error'])
    assert.equal(up.body.error, null)
    assert.equal(up.body.data.path, 'backups/backup_g1/x.json')

    const down = await s.handle('download', { bucket: 'backup', path: 'backups/backup_g1/x.json' }, { userId: 'u1' })
    assert.deepEqual(down, { status: 200, body: { data: b64('{"a":1}'), error: null } })

    const ls = await s.handle('list', { bucket: 'backup', path: 'backups/backup_g1', options: { sortBy: { column: 'name', order: 'desc' } } }, { userId: 'u1' })
    assert.equal(ls.status, 200)
    assert.equal(ls.body.data[0].name, 'x.json')
    assert.equal(ls.body.data[0].metadata.size, 7)
    // JSON-serialisable as server.js will send it
    assert.doesNotThrow(() => JSON.stringify(ls.body))
  })

  it('maps errors to {data:null, error:{message,code}} with HTTP status', async () => {
    const s = make()
    const r1 = await s.handle('download', { bucket: 'backup', path: 'nope.json' })
    assert.deepEqual(r1, { status: 404, body: { data: null, error: { message: 'Object not found', code: 'OV_STORAGE_NOT_FOUND' } } })
    const r2 = await s.handle('upload', { bucket: 'backup', path: '../x.json', fileBase64: '' })
    assert.equal(r2.status, 400)
    assert.equal(r2.body.error.code, 'OV_STORAGE_INVALID_PATH')
    assert.equal((await s.handle('upload', null)).status, 400)
    assert.equal((await s.handle('upload', [])).status, 400)
    assert.equal((await s.handle('remove', {})).status, 404)
  })

  it('signed-url is removed (404)', async () => {
    const r = await make().handle('signed-url', { bucket: 'scoresheets', path: 'x.json' })
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'OV_STORAGE_NO_SIGNED_URL')
  })

  it('unexpected errors become a generic 500 without leaking paths', async () => {
    const s = make({ statfs: plenty, checkQuota: () => { throw new Error(`boom at ${root}`) } })
    const r = await s.handle('upload', { bucket: 'backup', path: 'x.json', fileBase64: b64('{}') })
    assert.equal(r.status, 500)
    assert.equal(r.body.error.message, 'Storage operation failed')
    assert.ok(!JSON.stringify(r.body).includes(root))
  })

  it('error messages never contain filesystem paths', async () => {
    await fs.rm(path.join(root, SENTINEL_NAME))
    const r = await make().handle('upload', { bucket: 'backup', path: 'x.json', fileBase64: b64('{}') })
    assert.equal(r.status, 503)
    assert.ok(!JSON.stringify(r.body).includes(base))
  })
})
