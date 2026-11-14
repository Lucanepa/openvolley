/**
 * The recovery key of the backup files (envelope.js recovery slot): the strong
 * key beside the 6-digit PINs. Every file the app encrypts also has its data
 * key wrapped for this public key; the private half is kept offline by the
 * league (the operator of this build), on paper and in its vault, never on a
 * scoring device or the server. With it the recovery tool
 * (scripts/backup-recovery.mjs) opens any backup file, also one whose PINs
 * are lost; without it a copied file is only open to someone who guesses a
 * PIN.
 *
 * The key is a P-256 public key (SPKI, base64), set at build time:
 * VITE_BACKUP_RECOVERY_KEY, else BUILT_IN_RECOVERY_KEY below (what a build
 * from source, e.g. F-Droid's, reads). Empty: the files have PIN slots only.
 * `node scripts/backup-recovery.mjs keygen` makes a key pair.
 */

import { fromBase64, toBase64 } from './envelope.js'

// The operator's recovery public key (scripts/backup-recovery.mjs keygen)
export const BUILT_IN_RECOVERY_KEY = ''

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('No WebCrypto on this device')
  return s
}

/** The recovery public key of this build (SPKI, base64), or '' for none. */
export function configuredRecoveryKey() {
  let fromBuild = ''
  try {
    fromBuild = import.meta.env.VITE_BACKUP_RECOVERY_KEY || ''
  } catch {
    // not a Vite build (the recovery tool in Node: no import.meta.env)
  }
  return String(fromBuild || BUILT_IN_RECOVERY_KEY).replace(/\s+/g, '')
}

/** The id a recovery slot names its key by: the first 8 bytes of SHA-256 over the SPKI, hex. */
export async function recoveryKeyId(spkiBytes) {
  const hash = new Uint8Array(await subtle().digest('SHA-256', spkiBytes))
  return [...hash.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The recovery public key, ready for envelope.recoverySlot. Throws for
 * anything but a P-256 SPKI key.
 * @param {string} spkiBase64
 * @returns {Promise<{ id: string, publicKey: CryptoKey }>}
 */
export async function importRecoveryPublicKey(spkiBase64) {
  const spki = fromBase64(String(spkiBase64 || '').replace(/\s+/g, ''))
  const publicKey = await subtle().importKey('spki', spki, ECDH, true, [])
  return { id: await recoveryKeyId(spki), publicKey }
}

/**
 * The recovery private key (PKCS #8, base64) for the recovery tool, with the
 * id of its public half.
 * @returns {Promise<{ id: string, privateKey: CryptoKey }>}
 */
export async function importRecoveryPrivateKey(pkcs8Base64) {
  const s = subtle()
  const privateKey = await s.importKey('pkcs8', fromBase64(String(pkcs8Base64 || '').replace(/\s+/g, '')), ECDH, true, ['deriveBits'])
  // The public half from the private key's JWK (x, y)
  const { kty, crv, x, y } = await s.exportKey('jwk', privateKey)
  const publicKey = await s.importKey('jwk', { kty, crv, x, y, ext: true }, ECDH, true, [])
  const spki = new Uint8Array(await s.exportKey('spki', publicKey))
  return { id: await recoveryKeyId(spki), privateKey }
}

/**
 * A new recovery key pair (the recovery tool's keygen).
 * @returns {Promise<{ id: string, publicKey: string, privateKey: string }>} SPKI and PKCS #8, base64
 */
export async function generateRecoveryKeyPair() {
  const s = subtle()
  const pair = await s.generateKey(ECDH, true, ['deriveBits'])
  const spki = new Uint8Array(await s.exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await s.exportKey('pkcs8', pair.privateKey))
  return { id: await recoveryKeyId(spki), publicKey: toBase64(spki), privateKey: toBase64(pkcs8) }
}
