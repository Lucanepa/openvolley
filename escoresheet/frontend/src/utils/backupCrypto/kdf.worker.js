// Argon2id off the main thread (kdf.js): one derivation takes about half a
// second on a tablet, and the first backup of a match runs while the scorer
// is scoring.
import { argon2id } from 'hash-wasm'
import { argon2idOptions } from './argon2'

self.onmessage = async (e) => {
  const { id, pin, salt, params } = e.data || {}
  try {
    const key = await argon2id(argon2idOptions(pin, salt, params))
    self.postMessage({ id, key }, [key.buffer])
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
