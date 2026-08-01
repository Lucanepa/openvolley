// LEDbox wire protocol (Tech4Sport) — codec + TCP framing.
//
// Per http://apiledbox.tech4sport.com/ every message is a UTF-8 JSON string,
// gzip-compressed, exchanged as { cmd, value } -> { status, sender, value }.
//
// FRAMING CAVEAT: the docs' TCP examples read a raw recv() buffer and gunzip the
// whole thing, implying one gzip member == one message with no length prefix.
// gzip members are self-delimiting (magic 1f 8b ... 8-byte CRC/ISIZE footer), so
// on a stream we buffer bytes and try to gunzip the accumulation; a successful
// decode yields one message and we drop the consumed bytes. This matches the
// reference clients but MUST be confirmed against real hardware (a device that
// coalesces two messages into one TCP segment is the case to verify).

import zlib from 'node:zlib'

export function encode(obj) {
  // The board ignores the compressed size, so use level 1 (fastest) rather than zlib's
  // default 6 — markedly less CPU per frame on the event loop with no downside on the wire.
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 1 })
}

export function decode(buf) {
  return JSON.parse(zlib.gunzipSync(buf).toString('utf-8'))
}

// Incremental de-framer for a TCP byte stream. push() returns any fully-decoded
// messages found so far. Uses the gzip footer (ISIZE = uncompressed length mod
// 2^32) to locate member boundaries when several arrive back-to-back.
export class StreamDecoder {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    const out = []
    // Fast path: whole buffer is exactly one member.
    while (this.buf.length >= 18 /* min gzip size */) {
      const member = this.#takeOneMember()
      if (!member) break
      try {
        out.push(JSON.parse(zlib.gunzipSync(member).toString('utf-8')))
        this.buf = this.buf.subarray(member.length)
      } catch {
        // Not yet a complete member — wait for more bytes.
        break
      }
    }
    return out
  }

  // Returns the shortest prefix that gunzips cleanly, or null if incomplete.
  #takeOneMember() {
    if (this.buf[0] !== 0x1f || this.buf[1] !== 0x8b) {
      // Desync: drop a byte and resync on the next magic marker.
      const next = this.buf.indexOf(0x1f, 1)
      this.buf = next === -1 ? Buffer.alloc(0) : this.buf.subarray(next)
      return null
    }
    // Try progressively longer slices ending on a plausible footer boundary.
    for (let end = 18; end <= this.buf.length; end++) {
      const slice = this.buf.subarray(0, end)
      try {
        zlib.gunzipSync(slice)
        return slice
      } catch {
        /* keep growing */
      }
    }
    return null
  }
}

// #ef4444 / ef4444 / rgb(...) -> "r,g,b" (LEDbox colour format). Falls back to white.
export function hexToRgb(color, fallback = '255,255,255') {
  if (!color) return fallback
  const m = String(color).trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) {
    const rgb = String(color).match(/(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/)
    return rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : fallback
  }
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}
