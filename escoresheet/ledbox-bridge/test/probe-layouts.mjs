// The device ships exactly four layouts. Switch to each and ask GetSections what fields it
// holds — that is how we learn where a timeout countdown or a set-interval screen is meant
// to be drawn, instead of inventing a `timer` section that may not exist.
//
//   LEDBOX_HOST=192.168.5.1 node test/probe-layouts.mjs
import { LedboxClient } from '../src/ledboxClient.js'

const HOST = process.env.LEDBOX_HOST || '192.168.5.1'
const HOME = 'volleyball_matchscore_02'
const LAYOUTS = ['waiting', 'volleyball_matchscore_02', 'volleyball_matchscore_timeout_02', 'volleyball_matchscore_set_02']

const client = new LedboxClient({ host: HOST, reconnectMs: 0, connectTimeoutMs: 6000 })
client.on('error', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const trySend = async (cmd, value, extra) => {
  try { return { ok: true, value: await client.send(cmd, value, extra, { timeoutMs: 3500 }) } }
  catch (e) { return { ok: false, err: e.message } }
}

client.on('ready', async () => {
  for (const layout of LAYOUTS) {
    await trySend('SetLayout', layout)
    await sleep(1200) // let the device actually render it before asking what is on it
    const cur = await trySend('GetLayout', '')
    const read = await trySend('GetSections', '')
    console.log(`\n=== ${layout} ===   (device reports current: ${cur.ok ? cur.value : cur.err})`)
    if (!read.ok) { console.log(`  GetSections failed: ${read.err}`); continue }
    const secs = read.value || []
    console.log(`  ${secs.length} sections:`)
    for (const s of secs) {
      const bits = (s.value || []).map((a) => `${a.attrib}=${JSON.stringify(a.value)}`).join('  ')
      console.log(`    ${String(s.name).padEnd(14)} ${bits}`)
    }
  }

  await trySend('SetLayout', HOME)
  client.disconnect()
  setTimeout(() => process.exit(0), 500)
})

client.connect()
setTimeout(() => { console.log('probe timed out'); process.exit(1) }, 120000)
