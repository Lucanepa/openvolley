/**
 * USB stick copies of the match backups: the desktop app's stick_* commands
 * (src-tauri/src/stick.rs). The page never sees a path: a stick is the id the
 * last stick_list handed out, a file is <matchDir>/<fileName> inside the
 * app's folder on the stick (OpenVolley/, OpenBeach/).
 *
 *   list()                                     -> [{ id, label, fs, freeBytes, totalBytes, readOnly, locked, hasFolder }]
 *   mirror({ stickIds?, matchDir, sourceFile, destFile, verify })
 *                                              -> [{ id, label, ok, sha256?, bytes?, verified, at?, error?, message? }]
 *   listBackups(stickId)                       -> [{ dir, files: [{ name, size, modifiedMs, header? }] }]
 *   read(stickId, matchDir, fileName)          -> the file's text
 *   remove(stickId, matchDir, fileNames)       -> number removed
 *
 * A failed copy is a result with `error` one of STICK_ERRORS; a call the
 * command refuses as a whole rejects with "<code>: <message>".
 */

import { detectBackupPlatform } from '../nativeBackup/platform'

export const STICK_ERRORS = ['removed', 'readOnly', 'full', 'locked', 'io']

/** The error code of a rejected stick_* call ("full: 3 bytes free" -> 'full'). */
export function stickErrorCode(err) {
  const code = String(err?.message ?? err ?? '').split(':')[0].trim()
  return STICK_ERRORS.includes(code) ? code : 'io'
}

/** The stick commands, or null outside the desktop app (browsers, LAN tablets, Android). */
export function createStickPlatform(win = typeof window !== 'undefined' ? window : undefined) {
  if (detectBackupPlatform(win) !== 'tauri') return null
  const invoke = (cmd, args) => win.__TAURI_INTERNALS__.invoke(cmd, args)
  return {
    async list() {
      return (await invoke('stick_list')) || []
    },
    async mirror({ stickIds = null, matchDir, sourceFile, destFile, verify = true }) {
      return (await invoke('stick_mirror', { stickIds, matchDir, sourceFile, destFile, verify })) || []
    },
    async listBackups(stickId) {
      return (await invoke('stick_list_backups', { stickId })) || []
    },
    read(stickId, matchDir, fileName) {
      return invoke('stick_read', { stickId, matchDir, fileName })
    },
    remove(stickId, matchDir, fileNames) {
      return invoke('stick_remove', { stickId, matchDir, fileNames })
    }
  }
}
