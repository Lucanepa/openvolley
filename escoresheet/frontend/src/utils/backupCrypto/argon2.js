/**
 * The one Argon2id call of the backup encryption (hash-wasm), shared by the
 * KDF worker and the in-thread fallback (kdf.js), so both derive the same key.
 */

/** hash-wasm argon2id options: a 32-byte (AES-256) key from a PIN and a salt. */
export function argon2idOptions(pin, salt, params) {
  return {
    password: String(pin),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: 32,
    outputType: 'binary'
  }
}
