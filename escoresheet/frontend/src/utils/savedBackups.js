/**
 * The backups a restore can pick from, wherever they were saved:
 *
 *   device  the app's own backup folder (desktop, Android)
 *   drive   the OpenVolley/ folder of every USB stick (desktop)
 *   folder  the folder a browser (Chrome, Edge) was given
 *
 * Cloud backups have their own lists (backupManager). A list entry is
 * { key, source, where, title, sub, modifiedMs, encrypted, read() }: read()
 * resolves to the parsed file, which goes through matchBackupFromFile and the
 * PIN dialog (hooks/useBackupUnlock) like a picked file.
 */

import { parseBackupText } from './backupManager'
import { isEncryptedBackup } from './backupCrypto/envelope'

export const SAVED_BACKUP_LIMIT = 15
const LATEST = /(^|-)latest\.json$/

const num = (v) => (typeof v === 'number' ? v : 0)

/** Title and sub line of a backup file (plain or encrypted: the envelope's readable part). */
export function describeBackup(file, fallback = '') {
  if (!file) return { title: fallback, sub: '' }
  const r = isEncryptedBackup(file) ? file.readable : null
  const m = r || file.match || {}
  const home = r?.homeTeam ?? file.homeTeam?.name ?? m.homeTeam ?? ''
  const away = r?.awayTeam ?? file.awayTeam?.name ?? m.awayTeam ?? ''
  const gameN = m.gameN ?? m.game_n ?? m.gameNumber
  const teams = home && away ? `${home} – ${away}` : ''
  const title = [gameN ? `#${gameN}` : '', teams].filter(Boolean).join('  ') || fallback
  return { title, sub: r?.scheduledAt || m.scheduledAt || m.scheduled_at || '' }
}

function entry({ key, source, where, dir, modifiedMs, file, read }) {
  const { title, sub } = describeBackup(file, dir)
  return { key, source, where, title, sub, modifiedMs: num(modifiedMs), encrypted: isEncryptedBackup(file), read }
}

async function safe(fn) {
  try { return await fn() } catch { return null }
}

/** This device: each match folder's latest.json (newest folders first). */
export async function listDeviceBackups(store, limit = SAVED_BACKUP_LIMIT) {
  if (!store?.list || !store.read) return []
  const dirs = (await safe(() => store.list())) || []
  const candidates = dirs
    .map(d => ({ dir: d.dir, file: d.files.find(f => f.name === 'latest.json') }))
    .filter(x => x.file)
    .sort((a, b) => num(b.file.modifiedMs) - num(a.file.modifiedMs))
    .slice(0, limit)
  const out = []
  for (const c of candidates) {
    const text = await safe(() => store.read(c.dir, 'latest.json'))
    const file = text ? await safe(() => parseBackupText(text)) : null
    out.push(entry({
      key: `device:${c.dir}`, source: 'device', where: '', dir: c.dir, modifiedMs: c.file.modifiedMs, file,
      read: async () => parseBackupText(await store.read(c.dir, 'latest.json'))
    }))
  }
  return out
}

/** Every stick: each *-latest.json (the clear header of an encrypted file names the game). */
export async function listDriveBackups(platform, limit = SAVED_BACKUP_LIMIT) {
  if (!platform) return []
  const sticks = (await safe(() => platform.list())) || []
  const out = []
  for (const s of sticks) {
    const dirs = (await safe(() => platform.listBackups(s.id))) || []
    for (const d of dirs) {
      for (const f of d.files.filter(x => LATEST.test(x.name))) {
        const readable = f.header?.readable
        out.push({
          key: `drive:${s.id}:${d.dir}:${f.name}`,
          source: 'drive',
          where: s.label,
          title: readable ? describeBackup({ format: 'openvolley-encrypted-backup', readable }, d.dir).title : d.dir,
          sub: readable?.scheduledAt || '',
          modifiedMs: num(f.modifiedMs),
          encrypted: !!f.header?.encrypted,
          read: async () => parseBackupText(await platform.read(s.id, d.dir, f.name))
        })
      }
    }
  }
  return out.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit)
}

/** A browser folder (File System Access): its .json files, newest first. */
export async function listFolderBackups(dirHandle, limit = SAVED_BACKUP_LIMIT) {
  if (!dirHandle?.values) return []
  const files = []
  try {
    for await (const h of dirHandle.values()) {
      if (h.kind === 'file' && /\.json$/i.test(h.name)) {
        const f = await safe(() => h.getFile())
        if (f) files.push({ h, f })
      }
    }
  } catch {
    return []
  }
  files.sort((a, b) => b.f.lastModified - a.f.lastModified)
  const out = []
  for (const { h, f } of files.slice(0, limit)) {
    const file = await safe(async () => parseBackupText(await f.text()))
    out.push(entry({
      key: `folder:${h.name}`, source: 'folder', where: dirHandle.name || '', dir: h.name, modifiedMs: f.lastModified, file,
      read: async () => parseBackupText(await (await h.getFile()).text())
    }))
  }
  return out
}
