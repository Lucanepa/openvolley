/**
 * Test-only preload for a booted server.js (NODE_OPTIONS=--import, see
 * clockShiftEnv): every SIGUSR2 moves Date.now() ahead by
 * OV_TEST_CLOCK_STEP_MS, so a test passes the relay's take-over grace
 * (10 minutes for a match in play) without waiting it out. Timers keep real
 * time; the relay reads its clocks from Date.now(). The server never loads
 * this itself.
 */
const step = Number(process.env.OV_TEST_CLOCK_STEP_MS) || 0
const realNow = Date.now.bind(Date)
let ahead = 0
Date.now = () => realNow() + ahead
process.on('SIGUSR2', () => {
  ahead += step
  console.log(`[test clock] ahead by ${ahead} ms`)
})
