import { describe, it, expect, beforeEach } from 'vitest'
import { teamCodeFromHash, teamLinkUrl } from '../managerSite'
import { readPendingTeamLink, takeTeamLinkFromLocation, PENDING_TEAM_LINK_KEY, PENDING_TEAM_LINK_TTL_MS } from '../teamLink'

describe('team links (db/023)', () => {
  beforeEach(() => localStorage.clear())

  it('point at the manager site this page belongs to, the code in the fragment', () => {
    expect(teamLinkUrl('ABCD-EFGH-JKMN', 'manager.openvolley.app')).toBe('https://manager.openvolley.app/#team=ABCD-EFGH-JKMN')
    expect(teamLinkUrl('ABCD-EFGH-JKMN', 'app.openvolley.app')).toBe('https://manager.openvolley.app/#team=ABCD-EFGH-JKMN')
    expect(teamLinkUrl('ABCD-EFGH-JKMN', 'dev.openvolley-manager.pages.dev')).toBe('https://dev.openvolley-manager.pages.dev/#team=ABCD-EFGH-JKMN')
    expect(teamLinkUrl('ABCD-EFGH-JKMN', 'dev.openvolley-app.pages.dev')).toBe('https://dev.openvolley-manager.pages.dev/#team=ABCD-EFGH-JKMN')
    expect(teamLinkUrl('ABCD-EFGH-JKMN', 'localhost')).toBe('https://manager.openvolley.app/#team=ABCD-EFGH-JKMN')
  })

  it('read the code from the hash, nothing else', () => {
    expect(teamCodeFromHash('#team=abcd-efgh-jkmn')).toBe('ABCD-EFGH-JKMN')
    expect(teamCodeFromHash('#team=ABCDEFGHJKMN')).toBe('ABCDEFGHJKMN')
    expect(teamCodeFromHash('#myteams')).toBeNull()
    expect(teamCodeFromHash('#team=<script>')).toBeNull()
    expect(teamCodeFromHash('#team=ABCD')).toBeNull()
  })

  it('are taken out of the URL and kept for a week', () => {
    window.history.replaceState(null, '', '/#team=ABCD-EFGH-JKMN')
    expect(takeTeamLinkFromLocation(window)).toBe('ABCD-EFGH-JKMN')
    expect(window.location.hash).toBe('')
    expect(readPendingTeamLink()).toBe('ABCD-EFGH-JKMN')
    expect(readPendingTeamLink(Date.now() + PENDING_TEAM_LINK_TTL_MS + 1)).toBeNull()
    expect(localStorage.getItem(PENDING_TEAM_LINK_KEY)).toBeNull()
    expect(takeTeamLinkFromLocation(window)).toBeNull()
  })
})
