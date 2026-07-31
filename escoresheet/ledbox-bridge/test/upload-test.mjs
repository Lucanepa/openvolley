// End-to-end test of the board's file-upload protocol.
//
// This is the code path whose control flow was restructured (the post-upload
// finalization block was trapped inside the TCP/Bluetooth branch), so it needs a real
// round trip: Upload command on 8889 -> raw bytes on 12345 -> "Uploaded" ack back on
// 8889 -> file actually on disk.
import net from 'node:net'
import zlib from 'node:zlib'
import fs from 'node:fs'

const HOST = '192.168.5.1'
const FILE = process.argv[2] || '/tmp/kscw_crest.png'
const NAME = process.argv[3] || 'upload_test.png'
const bytes = fs.readFileSync(FILE)

const ctl = net.createConnection({ host: HOST, port: 8889 })
ctl.setTimeout(20000)
let buf = Buffer.alloc(0)
const send = (o) => { console.log('>>', JSON.stringify(o).slice(0, 130)); ctl.write(zlib.gzipSync(Buffer.from(JSON.stringify(o)))) }

let stage = 0
ctl.on('connect', () => {
  console.log(`connected; uploading ${bytes.length} bytes as ${NAME}`)
  send({ cmd: 'Init', alias: 'uploadtest', sport: 'volleyball', value: { version: 2 } })
})

ctl.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  let txt
  try { txt = zlib.gunzipSync(buf).toString('utf8') } catch { txt = buf.toString('utf8') }
  if (!txt.trim().endsWith('}')) return
  buf = Buffer.alloc(0)
  console.log('<<', txt.trim().slice(0, 200))

  if (stage === 0) {
    stage = 1
    // alias/sport are top-level; type+filename live in value (from ledboxAPI.Upload)
    send({ cmd: 'Upload', alias: 'uploadtest', sport: 'volleyball',
           value: { type: 'media', filename: NAME, forceUpload: true } })
  } else if (stage === 1) {
    stage = 2
    // The board now expects the raw bytes on 12345. Close = EOF.
    console.log('-- streaming file on port 12345 --')
    const up = net.createConnection({ host: HOST, port: 12345 }, () => {
      up.write(bytes, () => up.end())
    })
    up.on('close', () => console.log('-- stream closed, waiting for ack --'))
    up.on('error', (e) => { console.log('UPLOAD SOCKET ERR', e.message); process.exit(1) })
  } else {
    const ok = /Uploaded/.test(txt) && !/error/i.test(txt)
    console.log(ok ? '=== ACK RECEIVED: upload finalized ===' : '=== NO CLEAN ACK ===')
    ctl.end()
    process.exit(ok ? 0 : 2)
  }
})

ctl.on('timeout', () => { console.log('TIMEOUT — no ack (finalization never ran?)'); process.exit(3) })
ctl.on('error', (e) => { console.log('ERR', e.message); process.exit(1) })
