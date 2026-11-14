#!/usr/bin/env node
/**
 * Deploy step, after the backend image that uploads to the 'scoresheets'
 * bucket only at the scorer apps' paths (lib/scoresheets.js
 * isScoresheetUploadPath): remove what an upload of any other path left
 * where an app's folder or file belongs. lib/storage.js never replaces a
 * folder with a file or the other way round (409 OV_STORAGE_CONFLICT), so
 * such an entry refused the real uploads there for good:
 *   a file named like a day folder ({day}, beach, beach/{day}): every
 *     scoresheet of that day (or every beach one);
 *   a folder named like a scoresheet file ({day}/game….pdf|json,
 *     beach/{day}/game….pdf|json; made by a file below it): that file.
 * Dry run unless --apply: lists them. --apply removes each with everything
 * below it, and the owner records of what goes. Nothing else is touched.
 * Idempotent; safe while the server runs (it no longer writes such paths).
 *
 * Usage (in the backend container, STORAGE_ROOT / STORAGE_DIR = the storage
 * root, default /data/storage; from the production folder of the compose file):
 *   docker compose exec ov-backend node scripts/scoresheet-paths.mjs           # list
 *   docker compose exec ov-backend node scripts/scoresheet-paths.mjs --apply   # remove
 *
 * Exit codes: 0 done, 1 error, 2 usage.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'
import { SCORESHEETS_BUCKET, SCORESHEET_DAY_RE, SCORESHEET_FILE_RE } from '../lib/scoresheets.js'

const USAGE = 'Usage: node scripts/scoresheet-paths.mjs [--apply]\nStorage root from STORAGE_ROOT / STORAGE_DIR (default /data/storage), the backend\'s.'

async function entries (dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => !d.name.startsWith('.'))
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return []
    throw err
  }
}

/**
 * The entries of the bucket folder `bucketDir` in the way of the apps'
 * paths: [{ path, kind: 'file' | 'folder' }], by path. Symlinks are never
 * followed (lib/storage.js writes none).
 */
export async function findBlockingEntries (bucketDir) {
  const found = []
  // in a day folder: a folder where a scoresheet file goes
  const dayFolder = async (rel) => {
    for (const d of await entries(path.join(bucketDir, ...rel.split('/')))) {
      if (d.isDirectory() && SCORESHEET_FILE_RE.test(d.name)) found.push({ path: `${rel}/${d.name}`, kind: 'folder' })
    }
  }
  for (const d of await entries(bucketDir)) {
    if (d.name !== 'beach' && !SCORESHEET_DAY_RE.test(d.name)) continue
    if (!d.isDirectory()) {
      if (d.isFile()) found.push({ path: d.name, kind: 'file' })
    } else if (d.name !== 'beach') {
      await dayFolder(d.name)
    } else {
      for (const b of await entries(path.join(bucketDir, 'beach'))) {
        if (!SCORESHEET_DAY_RE.test(b.name)) continue
        if (b.isDirectory()) await dayFolder(`beach/${b.name}`)
        else if (b.isFile()) found.push({ path: `beach/${b.name}`, kind: 'file' })
      }
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const unknown = args.filter((a) => a !== '--apply')
  if (unknown.length) {
    console.error(`Unknown argument ${unknown[0]}\n${USAGE}`)
    return 2
  }
  const env = { ...process.env, STORAGE_DIR: process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage' }
  const storage = createStorage({ ...storageOptionsFromEnv(env), logger: console })
  const apply = args.includes('--apply')
  const found = await findBlockingEntries(path.join(storage.root, SCORESHEETS_BUCKET))
  for (const e of found) {
    if (!apply) {
      console.log(`${e.kind} ${e.path}`)
      continue
    }
    const r = await storage.removeTrusted({ bucket: SCORESHEETS_BUCKET, path: e.path })
    console.log(`removed ${e.kind} ${e.path} (${r.objectsRemoved} files)`)
  }
  console.log(`${found.length} entries in the way of the apps' scoresheet paths: ${apply ? 'removed' : 'to remove (dry run: --apply removes them)'}`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    console.error('scoresheet-paths failed:', err?.code ? `${err.code}: ${err.message}` : err?.message || err)
    process.exit(1)
  })
}
