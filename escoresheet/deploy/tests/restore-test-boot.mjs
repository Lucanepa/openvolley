#!/usr/bin/env node
// Part of restore-test.test.sh: boots the real backend (escoresheet/backend
// server.js, NODE_ENV=production as the image sets it) with exactly the
// settings of an env file restore-test.sh handed the backend container, on a
// throwaway database of PG_TEST_URL (as a role with the grants of roles.sql)
// and scratch storage and status directories in place of the container's.
//
//   node restore-test-boot.mjs <env-file> <boot|exit>
//     boot: /health/live must answer 200 (exit 0), else exit 1
//     exit: the server must stop by itself with a [Config] error (exit 0)
// Needs escoresheet/backend/node_modules (npm ci) and PG_TEST_URL.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [envFile, want] = process.argv.slice(2)
if (!envFile || !['boot', 'exit'].includes(want)) {
  console.error('usage: restore-test-boot.mjs <env-file> <boot|exit>')
  process.exit(2)
}
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend')
const { provisionDatabase, freePort, sleep } = await import(join(BACKEND, 'tests', 'helpers', 'e2eServer.js'))

const fileEnv = {}
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) fileEnv[m[1]] = m[2]
}

const db = await provisionDatabase()
const scratch = mkdtempSync(join(tmpdir(), 'ov-restore-boot-'))
const storage = join(scratch, 'storage')
const status = join(scratch, 'status')
mkdirSync(storage)
mkdirSync(status)
writeFileSync(join(storage, '.ovdata'), '')
writeFileSync(join(status, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
const port = await freePort()
const env = {
  PATH: process.env.PATH,
  HOME: scratch,
  NODE_ENV: 'production',
  ...fileEnv,
  // the container's database, mounts and port, here
  DATABASE_URL: db.appUrl(),
  STORAGE_ROOT: storage,
  STATUS_DIR: status,
  PORT: String(port)
}
const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })
let exited = null
child.on('exit', (code) => { exited = code })

let result = 'timeout'
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  if (exited !== null) { result = `exited ${exited}`; break }
  const r = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => null)
  if (r && r.status === 200) { result = 'booted'; break }
  await sleep(200)
}
if (exited === null) {
  child.kill('SIGTERM')
  await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r() }, 5000); child.once('exit', () => { clearTimeout(t); r() }) })
}
await db.drop()
rmSync(scratch, { recursive: true, force: true })

const configLines = out.split('\n').filter((l) => l.includes('[Config]')).slice(0, 3)
console.log(`restore-test-boot: ${result}${configLines.length ? `; ${configLines.join(' | ')}` : ''}`)
if (want === 'boot') process.exit(result === 'booted' ? 0 : 1)
process.exit(result.startsWith('exited') && exited !== 0 && configLines.length ? 0 : 1)
