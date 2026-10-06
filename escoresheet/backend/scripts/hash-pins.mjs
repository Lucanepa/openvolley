#!/usr/bin/env node
/**
 * Owner CLI: rewrite the plaintext PINs still stored in public.matches
 * (game_pin, every connection_pins value) in their hashed form
 * (lib/pinHash.js), with the server's OV_PIN_SECRET.
 *
 * The backend hashes every PIN it writes once OV_PIN_SECRET is set and accepts
 * both forms on read, so this is only needed for rows written before that.
 * Idempotent: hashed values are left alone. Dry run unless --apply.
 *
 * Usage (on hetzner, with the backend's environment):
 *   docker exec -it ov-backend node scripts/hash-pins.mjs           # count only
 *   docker exec -it ov-backend node scripts/hash-pins.mjs --apply   # rewrite
 *
 * Never prints a PIN. Exit codes: 0 done, 1 error, 2 usage.
 */

import pg from 'pg'
import { createPinHasher, isHashedPin } from '../lib/pinHash.js'

const USAGE = 'Usage: node scripts/hash-pins.mjs [--apply]\nNeeds DATABASE_URL and OV_PIN_SECRET (the backend\'s).'

/** Does this matches row still hold a plaintext PIN? */
export function hasPlaintextPin (row) {
  const plain = (v) => (typeof v === 'string' && v.trim() !== '' && !isHashedPin(v)) || typeof v === 'number'
  if (plain(row.game_pin)) return true
  const cp = row.connection_pins
  return !!cp && typeof cp === 'object' && !Array.isArray(cp) && Object.values(cp).some(plain)
}

/**
 * Rewrite the plaintext PINs of every matches row. Returns { scanned, rewritten }.
 * @param {pg.Pool|pg.Client} db
 * @param {ReturnType<typeof createPinHasher>} hasher
 */
export async function hashStoredPins (db, hasher, { apply = false, batch = 500 } = {}) {
  if (!hasher.enabled) throw new Error('OV_PIN_SECRET is not set: nothing to hash with')
  let scanned = 0
  let rewritten = 0
  let after = null
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, game_pin, connection_pins FROM public.matches
        WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [after, batch])
    if (rows.length === 0) break
    after = rows[rows.length - 1].id
    for (const row of rows) {
      scanned++
      if (!hasPlaintextPin(row)) continue
      rewritten++
      if (!apply) continue
      const out = hasher.hashMatchRow({ game_pin: row.game_pin, connection_pins: row.connection_pins })
      await db.query(
        'UPDATE public.matches SET game_pin = $2, connection_pins = $3::jsonb WHERE id = $1',
        [row.id, out.game_pin ?? null, out.connection_pins == null ? null : JSON.stringify(out.connection_pins)])
    }
  }
  return { scanned, rewritten }
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
  if (!process.env.DATABASE_URL) {
    console.error(`DATABASE_URL is not set.\n${USAGE}`)
    return 2
  }
  const hasher = createPinHasher(process.env.OV_PIN_SECRET || null)
  if (!hasher.enabled) {
    console.error(`OV_PIN_SECRET is not set.\n${USAGE}`)
    return 2
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const apply = args.includes('--apply')
    const r = await hashStoredPins(pool, hasher, { apply })
    console.log(`${r.scanned} matches scanned, ${r.rewritten} with plaintext PINs ${apply ? 'rewritten' : '(dry run: --apply rewrites them)'}`)
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    console.error('hash-pins failed:', err.message)
    process.exit(1)
  })
}
