// Review findings whose fix lives in components too large to render in a
// unit test (App, MatchSetup, Scoreboard): the helpers are tested here, and
// the source is checked for the wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { restorePrefill } from '../../utils/manageNav'

const src = (rel) => readFileSync(resolve(__dirname, rel), 'utf8')

describe('"Join with game PIN" fills the restore dialog\'s game number', () => {
  it('restorePrefill puts the game number into the field the dialog reads', () => {
    expect(restorePrefill({ gameN: 123456 })).toEqual({ cloudBackupGameN: '123456', cloudBackupPin: '', cloudBackupError: '' })
    expect(restorePrefill({ gameN: null })).toEqual({ cloudBackupGameN: '', cloudBackupPin: '', cloudBackupError: '' })
    expect(restorePrefill(undefined).cloudBackupGameN).toBe('')
  })

  it('App sets cloudBackupGameN (the input\'s value) on OPEN_RESTORE_EVENT', () => {
    const app = src('../../App.jsx')
    const handler = app.slice(app.indexOf('const onRestore = (e) =>'), app.indexOf('window.addEventListener(OPEN_MANAGE_EVENT'))
    expect(handler).toContain('restorePrefill(e?.detail)')
    expect(handler).toContain('setCloudBackupGameN(fill.cloudBackupGameN)')
    expect(handler).not.toContain('setRestoreMatchIdInput')
    // the dialog's game number input is bound to cloudBackupGameN
    expect(app).toMatch(/value=\{cloudBackupGameN\}/)
  })
})

describe('MatchSetup', () => {
  const ms = src('../MatchSetup.jsx')

  it('confirmMatchInfo runs once at a time, and the button is disabled meanwhile', () => {
    expect(ms).toMatch(/if \(confirmingMatchInfoRef\.current\) return/)
    expect(ms).toContain('disabled={!canConfirmMatchInfo || confirmingMatchInfo}')
  })

  it('the official check before creating waits at most OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS', () => {
    expect(ms).toContain('timeoutMs: OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS')
  })

  it('the "stays on this device" note shows for every account that cannot score, not only pending ones', () => {
    expect(ms).toContain('access?.known && !access.canScore && !match?.test')
  })
})

describe('Scoreboard live state', () => {
  const sb = src('../Scoreboard.jsx')

  it('a server refusal pauses the cloud push for the match instead of opening a dialog per rally', () => {
    expect(sb).toContain('if (isLiveStateRefused(matchId)) return')
    expect(sb).toMatch(/isLiveStateRefusal\(liveStateResult\.error\)[\s\S]{0,300}markLiveStateRefused\(matchId/)
    expect(sb).toContain('window.addEventListener(ACCESS_CHANGED_EVENT, onAccess)')
  })
})
