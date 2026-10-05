#!/usr/bin/env node
/**
 * Operator CLI: who may read an object in an uploader-only storage bucket
 * (default: scoresheets). Final scoresheets are readable only by their owner
 * (backend/README "Who can read a scoresheet"); scoresheets stored before owner
 * records existed have none, so nobody can open them until you grant one here.
 *
 * Usage (STORAGE_ROOT or STORAGE_DIR = the storage root, default /data/storage):
 *   node scripts/storage-owner.mjs unowned [folder]          objects without any owner
 *   node scripts/storage-owner.mjs show  <path>              print the owners of one object
 *   node scripts/storage-owner.mjs grant <path> <user-uuid>...  add owners
 *   node scripts/storage-owner.mjs set   <path> [user-uuid...]  replace the owners (none = nobody)
 *   options: --bucket <name> (default scoresheets), --help
 *
 * <path> is the object path inside the bucket, e.g. 2026-05-12/game4711_final.json.
 *
 * Grant only to an account you have verified out of band: the scorer who
 * approved that match (e.g. the club confirms it, and the account's email
 * matches). A user_matches row is NOT proof: any account can write one for any
 * match. The user uuid of an email:
 *   psql "$DATABASE_URL" -c "SELECT id FROM auth.users WHERE email = lower('scorer@example.ch')"
 *
 * On hetzner:
 *   docker exec -it ov-backend node scripts/storage-owner.mjs unowned
 *
 * The running server never rewrites the record of an existing object, so this
 * is safe while it runs. Exit codes: 0 done, 1 error, 2 usage.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'

const USAGE = 'Usage: node scripts/storage-owner.mjs (unowned [folder] | show <path> | grant <path> <user-uuid>... | set <path> [user-uuid...]) [--bucket scoresheets]\n' +
  'Storage root from STORAGE_ROOT / STORAGE_DIR (default /data/storage).'

function parseArgs(argv) {
  const out = { bucket: 'scoresheets', help: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--bucket') out.bucket = argv[++i]
    else out.rest.push(a)
  }
  return out
}

async function listUnowned(storage, bucket, folder) {
  const base = path.join(storage.root, bucket, folder || '')
  const found = []
  async function walk(dir, rel) {
    let dirents
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) await walk(path.join(dir, d.name), r)
      else if (d.isFile() && !(await storage.getOwners({ bucket, path: r })).length) found.push(r)
    }
  }
  await walk(base, folder ? folder.replace(/\/+$/, '') : '')
  return found.sort()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [cmd, target, ...users] = args.rest
  if (args.help || !cmd) {
    console.log(USAGE)
    return args.help ? 0 : 2
  }
  const env = { ...process.env, STORAGE_DIR: process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage' }
  const storage = createStorage({ ...storageOptionsFromEnv(env), logger: console })
  if (!storage.uploaderReadBuckets.includes(args.bucket)) {
    console.error(`${args.bucket} is not an uploader-only bucket (STORAGE_UPLOADER_READ_BUCKETS)`)
    return 2
  }
  if (cmd === 'unowned') {
    for (const p of await listUnowned(storage, args.bucket, target)) console.log(p)
    return 0
  }
  if (!target) {
    console.error(USAGE)
    return 2
  }
  if (cmd === 'show') {
    console.log(JSON.stringify(await storage.getOwners({ bucket: args.bucket, path: target })))
    return 0
  }
  if (cmd === 'grant' || cmd === 'set') {
    if (cmd === 'grant' && !users.length) {
      console.error(USAGE)
      return 2
    }
    const owners = await storage.setOwners({ bucket: args.bucket, path: target, userIds: users, mode: cmd === 'grant' ? 'add' : 'set' })
    console.log(JSON.stringify(owners))
    return 0
  }
  console.error(USAGE)
  return 2
}

main().then((code) => { process.exitCode = code }, (e) => {
  console.error(e?.code ? `${e.code}: ${e.message}` : e?.message || e)
  process.exitCode = 1
})
