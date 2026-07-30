// A mock LEDbox that speaks the real Tech4Sport TCP protocol closely enough to catch
// integration bugs with no hardware. It keeps an in-memory "screen" (section name ->
// {text,color}) that a test can assert against. The contract mirrors a real C0270
// (firmware 0.551, verified 2026-07-30): Init requires integer version 2, SetSections
// uses the single-object WRITE shape (not the array READ shape), and SetLayout only
// accepts layouts the device actually has.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'

// Sections present in the volleyball_matchscore_02 layout (+ generic waiting/timer).
const KNOWN_SECTIONS = new Set([
  'team1', 'team2', 'score1', 'score2', 'set1', 'set2',
  'timeout1', 'timeout2', 'sub1', 'sub2', 'serve1', 'serve2',
  'vs', 'lbl_to', 'lbl_sub', 'bg_score1', 'bg_score2', 'mode', 'banner', 'timer',
])
const KNOWN_LAYOUTS = new Set([
  'waiting', 'volleyball_matchscore_02',
  'volleyball_matchscore_timeout_02', 'volleyball_matchscore_set_02',
])

export class MockLedbox extends EventEmitter {
  constructor({ deviceName = 'MOCK01', firmware = '0.551' } = {}) {
    super()
    this.deviceName = deviceName
    this.firmware = firmware
    this.currentLayout = 'waiting'
    this.screen = {} // section name -> { text, color }
  }

  listen(port = 8889, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server = net.createServer((sock) => {
        const decoder = new StreamDecoder()
        sock.on('data', (chunk) => {
          for (const msg of decoder.push(chunk)) this._handle(sock, msg)
        })
        sock.on('error', () => {})
      })
      this.server.listen(port, host, () => resolve(this.server.address()))
    })
  }

  // Real WRITE shape: each entry is { name, value: { attrib, value } } — a single
  // attribute object, NOT an array of attribs (that is the READ shape). Throws a
  // protocol error (with a numeric .code) on the wrong shape or an unknown section.
  _applySections(sections = []) {
    for (const s of sections) {
      if (Array.isArray(s.value)) {
        const e = new Error(`key 'attrib' in section ${s.name} not defined`)
        e.code = 9
        throw e
      }
      if (!KNOWN_SECTIONS.has(s.name)) {
        const e = new Error('code 6 - section not found')
        e.code = 6
        throw e
      }
      const cur = this.screen[s.name] || {}
      const a = s.value || {}
      if (a.attrib === 'text') cur.text = a.value
      if (a.attrib === 'color') cur.color = a.value
      this.screen[s.name] = cur
    }
  }

  _handle(sock, msg) {
    this.emit('command', msg)
    const ok = (value, extra = {}) =>
      sock.write(encode({ status: 'ok', sender: msg.cmd, value, ...extra }))
    const err = (error_code, error_message) =>
      sock.write(encode({ status: 'error', sender: msg.cmd, error_code, error_message }))
    switch (msg.cmd) {
      case 'Init':
        // Real device requires an integer API version of 2; anything else -> error 8.
        if (msg.value?.version !== 2) return err(8, 'App not compatible')
        return ok({
          deviceName: this.deviceName, version: this.firmware, role: 'admin',
          current_layout: this.currentLayout,
          plugins: [{ name: 'escoresheet', version: 0.1, parameters: [] }],
        })
      case 'Info':
        return ok({ deviceName: this.deviceName, version: this.firmware })
      case 'GetLayout':
        return ok(this.currentLayout)
      case 'GetSections': {
        const out = Object.entries(this.screen).map(([name, v]) => {
          const value = []
          if (v.text !== undefined) value.push({ attrib: 'text', value: v.text })
          if (v.color !== undefined) value.push({ attrib: 'color', value: v.color })
          return { name, value }
        })
        return ok(out)
      }
      case 'SetLayout': {
        const name = msg.name || msg.value
        if (typeof name === 'string' && KNOWN_LAYOUTS.has(name)) {
          this.currentLayout = name
          return ok(name)
        }
        return err(5, 'code 5 - layout not present in device')
      }
      case 'SetSections':
        try {
          this._applySections(msg.value)
          return ok(true)
        } catch (e) {
          return err(e.code || 9, e.message)
        }
      case 'Disconnect':
        return sock.write(encode({ sender: 'Disconnect', value: '' }))
      default:
        return err(1, 'API not avaible')
    }
  }

  text(name) { return this.screen[name]?.text }
  color(name) { return this.screen[name]?.color }
  close() { return new Promise((r) => this.server.close(r)) }
}
