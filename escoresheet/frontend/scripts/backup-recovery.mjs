#!/usr/bin/env node
/**
 * The recovery key of the match backup files (src/utils/backupCrypto/
 * recovery.js): make the key pair, and open a backup file with its private
 * half when no PIN opens it. Node only, no network: run it on the offline
 * computer that holds the private key.
 *
 *   node scripts/backup-recovery.mjs keygen [--out <dir>]
 *       Writes openvolley-recovery-<id>.private.txt (keep it offline: paper
 *       and the vault, never on a scoring device or the server) and prints
 *       the public key for the build (VITE_BACKUP_RECOVERY_KEY or
 *       BUILT_IN_RECOVERY_KEY in recovery.js).
 *
 *   node scripts/backup-recovery.mjs open --key <private key file> <backup.json> [--out <file>]
 *       Writes the backup inside (default <backup>.opened.json, readable by
 *       this user only). It has no PINs: Restore match in the app takes it
 *       as a backup file and gives the match new connection PINs. It holds
 *       names, birth dates and signatures: delete it once the match is
 *       restored.
 *
 * Only files written from version 2 of the envelope by a build with the
 * recovery key have a recovery slot; older files open with a PIN only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isEncryptedBackup, openEnvelopeWithRecoveryKey } from '../src/utils/backupCrypto/envelope.js'
import { generateRecoveryKeyPair, importRecoveryPrivateKey } from '../src/utils/backupCrypto/recovery.js'

/** The backup inside an encrypted backup file's text, as JSON text. */
export async function openBackupText(fileText, privateKeyBase64) {
  const envelope = JSON.parse(fileText)
  if (!isEncryptedBackup(envelope)) throw new Error('Not an encrypted OpenVolley backup (a plain file needs no key)')
  const key = await importRecoveryPrivateKey(privateKeyBase64)
  const { data } = await openEnvelopeWithRecoveryKey(envelope, key)
  return JSON.stringify(data)
}

function option(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return null
  const value = args[i + 1]
  args.splice(i, 2)
  return value ?? null
}

async function keygen(args) {
  const dir = option(args, '--out') || '.'
  const { id, publicKey, privateKey } = await generateRecoveryKeyPair()
  const file = path.join(dir, `openvolley-recovery-${id}.private.txt`)
  fs.writeFileSync(file, `${privateKey}\n`, { mode: 0o600, flag: 'wx' })
  console.log(`Private key (keep it offline): ${file}`)
  console.log(`Key id: ${id}`)
  console.log('Public key for the build (VITE_BACKUP_RECOVERY_KEY or BUILT_IN_RECOVERY_KEY):')
  console.log(publicKey)
}

async function open(args) {
  const keyFile = option(args, '--key')
  const out = option(args, '--out')
  const [input] = args
  if (!keyFile || !input) throw new Error('usage: open --key <private key file> <backup.json> [--out <file>]')
  const text = await openBackupText(fs.readFileSync(input, 'utf8'), fs.readFileSync(keyFile, 'utf8'))
  const target = out || input.replace(/\.json$/i, '') + '.opened.json'
  fs.writeFileSync(target, text, { mode: 0o600, flag: 'wx' })
  console.log(`Opened: ${target} (delete it once the match is restored)`)
}

async function main(argv) {
  const [command, ...args] = argv
  if (command === 'keygen') return keygen(args)
  if (command === 'open') return open(args)
  console.error('usage: backup-recovery.mjs keygen [--out <dir>] | open --key <private key file> <backup.json> [--out <file>]')
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.code === 'OV_BACKUP_WRONG_PIN' ? 'This key opens no slot of the file (another key, or a file without a recovery slot)' : (e?.message || String(e)))
    process.exitCode = 1
  })
}
