/**
 * Leaving a finished match for the home screen (header Menu > Home) must
 * leave Match End too: App shows Match End while `showMatchEnd &&
 * matchId`, so a flag left on opened the NEXT match as "Match complete"
 * (0:0, the previous winner) right after its coin toss (seen in the desktop
 * app). App.jsx is too large to mount: this pins the two exits.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const app = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')
const body = (head) => {
  const start = app.indexOf(head)
  expect(start, head).toBeGreaterThan(-1)
  return app.slice(start, app.indexOf('\n  }\n', start))
}

describe('the home screen leaves Match End', () => {
  it.each(['const openMatchSetup = () => {', 'const goHome = async () => {'])('%s', (head) => {
    const b = body(head)
    expect(b).toContain('setMatchId(null)')
    expect(b).toContain('setShowMatchEnd(false)')
  })
})
