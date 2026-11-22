/**
 * Test-only preload for a booted server.js (NODE_OPTIONS=--import, see
 * fakeResendEnv): requests to the Resend API (https://api.resend.com/emails)
 * never leave the machine. Each one is appended as a JSON line ({ to,
 * subject, text, authorization }) to OV_TEST_RESEND_LOG and answered like
 * Resend does ({ id }). OV_TEST_RESEND_FAIL=1 answers 422 with a message that
 * names the address, as Resend's own errors can. Every other fetch is the
 * real one. The server never loads this itself.
 */
import { appendFileSync } from 'node:fs'

const LOG = process.env.OV_TEST_RESEND_LOG
const realFetch = globalThis.fetch

globalThis.fetch = async function fakeResendFetch (input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url
  if (typeof url !== 'string' || !url.startsWith('https://api.resend.com/')) return realFetch(input, init)
  let body = {}
  try { body = JSON.parse(init.body || '{}') } catch { /* not JSON */ }
  const headers = new Headers(init.headers || {})
  if (process.env.OV_TEST_RESEND_FAIL === '1') {
    return new Response(JSON.stringify({ message: `Invalid \`to\` field: ${JSON.stringify(body.to)}` }), { status: 422, headers: { 'Content-Type': 'application/json' } })
  }
  if (LOG) appendFileSync(LOG, JSON.stringify({ to: body.to, from: body.from, subject: body.subject, text: body.text, authorization: headers.get('authorization') }) + '\n')
  return new Response(JSON.stringify({ id: `fake_${Date.now()}` }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
