// A mock LEDbox that speaks the documented TCP protocol, so the client + mapper
// can be validated end-to-end with no hardware. It keeps an in-memory "screen"
// (section name -> {text,color}) that a test can assert against.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'

export class MockLedbox extends EventEmitter {
  constructor({ deviceName = 'MOCK01', firmware = 0.5 } = {}) {
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

  _applySections(sections = []) {
    for (const s of sections) {
      const cur = this.screen[s.name] || {}
      const attrs = Array.isArray(s.value) ? s.value : [s.value]
      for (const a of attrs) {
        if (a.attrib === 'text') cur.text = a.value
        if (a.attrib === 'color') cur.color = a.value
      }
      this.screen[s.name] = cur
    }
  }

  _handle(sock, msg) {
    this.emit('command', msg)
    const reply = (value, extra = {}) =>
      sock.write(encode({ status: 'ok', sender: msg.cmd, value, ...extra }))
    switch (msg.cmd) {
      case 'Init':
        reply({ deviceName: this.deviceName, version: this.firmware, role: 'admin', current_layout: this.currentLayout, plugins: [] })
        break
      case 'Info':
        reply({ deviceName: this.deviceName, version: this.firmware })
        break
      case 'SetLayout':
        this.currentLayout = msg.name || msg.value
        if (Array.isArray(msg.value)) this._applySections(msg.value)
        reply(this.currentLayout)
        break
      case 'SetSection':
        this._applySections([{ name: msg.name, value: msg.value }])
        reply(true)
        break
      case 'SetSections':
        this._applySections(msg.value)
        reply(true)
        break
      case 'Disconnect':
        sock.write(encode({ sender: 'Disconnect', value: '' }))
        break
      default:
        sock.write(encode({ status: 'Error', sender: msg.cmd, error_code: 404, message: 'unknown cmd' }))
    }
  }

  text(name) { return this.screen[name]?.text }
  close() { return new Promise((r) => this.server.close(r)) }
}
