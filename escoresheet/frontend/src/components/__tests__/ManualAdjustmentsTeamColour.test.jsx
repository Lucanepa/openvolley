// ManualAdjustments: a team colour that is none of the dropdown's own colours
// keeps its own option. A custom colour from the picker reads "Custom colour
// #…"; one of Match setup's twelve shirts the list lacks (white #FFFFFF,
// black #000000, red #dc2626...) is no custom colour and shows its code.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))

import '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterEach(cleanup)
afterAll(() => {
  globalThis.fetch = saved.fetch
})

async function colourSelects(homeColour, awayColour) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: homeColour })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: awayColour })
  const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: true, homeColor: homeColour, awayColor: awayColour })
  render(<ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} />)
  const teamsTab = await screen.findByRole('radio', { name: 'Teams' }).catch(() => screen.findByRole('button', { name: 'Teams' }))
  fireEvent.click(teamsTab)
  let selects = []
  await waitFor(() => {
    selects = [...document.querySelectorAll('select')].filter(s => [...s.options].some(o => o.value === '#3b82f6'))
    expect(selects).toHaveLength(2)
  }, { timeout: 5000 })
  return selects
}

describe('ManualAdjustments: team colour dropdown', () => {
  it('a custom colour is its own option, "Custom colour #…", and stays selected', async () => {
    const [home, away] = await colourSelects('#7b1e2b', '#3b82f6')
    expect(home.value).toBe('#7b1e2b')
    expect(home.options[home.selectedIndex].text).toBe('Custom colour #7b1e2b ■')
    expect(away.value).toBe('#3b82f6')
    expect([...away.options].some(o => /Custom colour/.test(o.text))).toBe(false)
  }, 30000)

  it("one of Match setup's shirts the list lacks shows its code, not \"Custom colour\"", async () => {
    const [home, away] = await colourSelects('#FFFFFF', '#000000')
    expect(home.value).toBe('#FFFFFF')
    expect(home.options[home.selectedIndex].text).toBe('#FFFFFF ■')
    expect(away.value).toBe('#000000')
    expect(away.options[away.selectedIndex].text).toBe('#000000 ■')
  }, 30000)
})
