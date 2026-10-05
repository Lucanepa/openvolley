#!/usr/bin/env node
/**
 * Owner CLI: set a user's password and revoke all of their sessions.
 * Stands in for the Supabase password-reset mailer until Phase 7.
 *
 * Usage:
 *   DATABASE_URL=postgres://ov_owner@.../openvolley node scripts/set-password.mjs <email|uuid> [options]
 *
 * The new password is never taken from argv (it would land in shell history
 * and `ps`). It is read from:
 *   - a hidden prompt (asked twice) when stdin is a terminal, or
 *   - the first line of stdin when piped:   printf '%s\n' "$PW" | node scripts/set-password.mjs a@b.ch
 *
 * Options:
 *   --generate      generate a random 20-character password and print it once
 *   --revoke-only   do not change the password, only sign the user out everywhere
 *   --help
 *
 * On hetzner:
 *   docker exec -it ov-backend node scripts/set-password.mjs someone@example.com
 *
 * Exit codes: 0 done, 1 error, 2 usage.
 */

import { randomBytes } from 'node:crypto'
import { createAuth } from '../lib/auth.js'

const USAGE = 'Usage: node scripts/set-password.mjs <email|uuid> [--generate | --revoke-only]\n' +
  'Reads the new password from a hidden prompt, or from stdin when piped. Needs DATABASE_URL.'

function parseArgs(argv) {
  const opts = { target: null, generate: false, revokeOnly: false, help: false }
  for (const a of argv) {
    if (a === '--generate') opts.generate = true
    else if (a === '--revoke-only') opts.revokeOnly = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`)
    else if (!opts.target) opts.target = a
    else throw new Error('Only one user may be given')
  }
  if (opts.generate && opts.revokeOnly) throw new Error('--generate and --revoke-only exclude each other')
  return opts
}

function generatePassword() {
  // 20 chars from an unambiguous alphabet (~114 bits).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const out = []
  while (out.length < 20) {
    for (const b of randomBytes(32)) {
      if (b < alphabet.length * 4 && out.length < 20) out.push(alphabet[b % alphabet.length])
    }
  }
  return out.join('')
}

async function readPipedLine() {
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
    if (data.includes('\n')) break
  }
  return data.split(/\r?\n/)[0]
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process
    stderr.write(question)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (err) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stderr.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('Cancelled'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function readNewPassword() {
  if (!process.stdin.isTTY) return readPipedLine()
  const a = await promptHidden('New password: ')
  const b = await promptHidden('Repeat new password: ')
  if (a !== b) throw new Error('Passwords do not match')
  return a
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message + '\n' + USAGE)
    return 2
  }
  if (opts.help) { console.log(USAGE); return 0 }
  if (!opts.target) { console.error(USAGE); return 2 }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); return 2 }

  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const auth = createAuth({ pool, logger: console })
  try {
    if (opts.revokeOnly) {
      const { id, email } = await auth.findUserId(opts.target)
      const n = await auth.revokeUserSessions(id)
      console.log(`Revoked ${n} session(s) for ${email} (${id}).`)
      return 0
    }
    const password = opts.generate ? generatePassword() : await readNewPassword()
    const r = await auth.setPassword(opts.target, password)
    console.log(`Password set for ${r.email} (${r.userId}); revoked ${r.revokedSessions} session(s).`)
    if (opts.generate) console.log(`Generated password: ${password}`)
    return 0
  } catch (err) {
    console.error(`Error: ${err.message}`)
    return 1
  } finally {
    await pool.end()
  }
}

process.exitCode = await main()
