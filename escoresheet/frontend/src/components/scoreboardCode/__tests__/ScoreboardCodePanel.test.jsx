/**
 * "Show on a scoreboard" (components/scoreboardCode): the code, the QR link
 * with the code in the fragment, how long it is valid, the relay's answer,
 * New code and Stop sharing behind a confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('react-i18next', async () => {
  const en = (await import('../../../i18n/locales/en.json')).default
  const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  return {
    useTranslation: () => ({
      t: (key, opts) => String(typeof lookup(key) === 'string' ? lookup(key) : key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
    })
  }
})
const dialog = vi.hoisted(() => ({ calls: [], answer: true }))
vi.mock('../../../ui', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, confirmDialog: (opts) => { dialog.calls.push(opts); return Promise.resolve(dialog.answer) } }
})

import ScoreboardCodePanel, { validUntilLabel } from '../ScoreboardCodePanel'
import { createScoreboardCodes, MAX_LIFE_MS } from '../../../utils/scoreboardCode'

function fakeTable() {
  const rows = new Map()
  return {
    rows,
    get: async (id) => rows.get(id),
    put: async (row) => { rows.set(row.matchId, { ...row }) },
    delete: async (id) => { rows.delete(id) },
    toArray: async () => [...rows.values()],
    where: (index) => ({ equals: (v) => ({ first: async () => [...rows.values()].find((r) => r[index] === v) }) })
  }
}
function fakeRelay() {
  const listeners = new Set()
  return {
    url: 'wss://backend.openvolley.app',
    sent: [],
    isOpen: () => true,
    send(m) { this.sent.push(m); return true },
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(m) { for (const fn of listeners) fn(m, null) }
  }
}
let bytes = 0
const random = () => Uint8Array.from([bytes, 1, 2, 3, bytes++])

describe('ScoreboardCodePanel', () => {
  let relay, table, codes
  beforeEach(() => {
    dialog.calls = []
    dialog.answer = true
    relay = fakeRelay()
    table = fakeTable()
    codes = createScoreboardCodes({ relay, table: () => table, random })
  })
  const show = () => render(<ScoreboardCodePanel match={{ matchId: 5, relayKey: 'seed-5' }} onClose={() => {}} codes={codes} relay={relay} />)

  it('makes a code, shows it with its QR link and tells the relay', async () => {
    show()
    const code = await screen.findByTestId('scoreboard-code')
    expect(code.textContent).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    const raw = code.textContent.replace('-', '')
    expect(screen.getByTestId('scoreboard-code-link').textContent).toBe(`https://livescore.openvolley.app/board#${raw}`)
    expect(screen.getByText(/Open livescore\.openvolley\.app\/board on the scoreboard/)).toBeTruthy()
    expect(screen.getByTestId('scoreboard-code-status').textContent).toMatch(/Telling the server/)
    expect(screen.getByText(/never PINs, line-ups or shirt numbers/)).toBeTruthy()
    expect(relay.sent).toEqual([expect.objectContaining({ type: 'display-code-set', matchId: 'seed-5', code: raw })])
    act(() => relay.emit({ type: 'display-code-state', matchId: 'seed-5', active: true, endsAt: Date.now() + MAX_LIFE_MS }))
    expect(screen.getByTestId('scoreboard-code-status').textContent).toMatch(/Ready: scoreboards can follow/)
    act(() => relay.emit({ type: 'display-presence', matchId: 'seed-5', present: true, settingsUrl: null }))
    await screen.findByTestId('scoreboard-code-following')
  })

  it('offers the same board as a stream overlay link, with Copy', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async () => {})
    try {
      show()
      const raw = (await screen.findByTestId('scoreboard-code')).textContent.replace('-', '')
      const link = `https://livescore.openvolley.app/board?overlay#${raw}`
      expect(screen.getByTestId('scoreboard-code-stream-link').textContent).toBe(link)
      expect(screen.getByText(/browser source in OBS/)).toBeTruthy()
      fireEvent.click(screen.getByTestId('scoreboard-code-stream-copy'))
      await waitFor(() => expect(screen.getByTestId('scoreboard-code-stream-copy').textContent).toBe('Copied'))
      expect(writeText).toHaveBeenCalledWith(link)
    } finally {
      writeText.mockRestore()
    }
  })

  it('New code asks first, then replaces the code', async () => {
    show()
    const before = (await screen.findByTestId('scoreboard-code')).textContent
    fireEvent.click(screen.getByTestId('scoreboard-code-new'))
    await waitFor(() => expect(screen.getByTestId('scoreboard-code').textContent).not.toBe(before))
    expect(dialog.calls[0]).toMatchObject({ title: 'Make a new code?', confirmLabel: 'New code' })
    expect(relay.sent.at(-1).code).toBe(screen.getByTestId('scoreboard-code').textContent.replace('-', ''))
  })

  it('a cancelled New code keeps the code', async () => {
    dialog.answer = false
    show()
    const before = (await screen.findByTestId('scoreboard-code')).textContent
    fireEvent.click(screen.getByTestId('scoreboard-code-new'))
    await waitFor(() => expect(dialog.calls).toHaveLength(1))
    expect(screen.getByTestId('scoreboard-code').textContent).toBe(before)
    expect(relay.sent).toHaveLength(1)
  })

  it('Stop sharing revokes it; Make a code makes a new one', async () => {
    show()
    await screen.findByTestId('scoreboard-code')
    fireEvent.click(screen.getByTestId('scoreboard-code-stop'))
    await screen.findByTestId('scoreboard-code-stopped')
    expect(relay.sent.at(-1)).toEqual({ type: 'display-code-set', matchId: 'seed-5', code: null })
    expect(table.rows.size).toBe(0)
    fireEvent.click(screen.getByTestId('scoreboard-code-make'))
    await screen.findByTestId('scoreboard-code')
    expect(table.rows.size).toBe(1)
  })

  it('says why when the relay refused it', async () => {
    show()
    await screen.findByTestId('scoreboard-code')
    act(() => relay.emit({ type: 'display-code-state', matchId: 'seed-5', active: false, reason: 'expired' }))
    expect(screen.getByTestId('scoreboard-code-status').textContent).toMatch(/has run out/)
  })

  it('a match without a room key cannot be shown', () => {
    render(<ScoreboardCodePanel match={{ matchId: 5, relayKey: null }} onClose={() => {}} codes={codes} relay={relay} />)
    expect(screen.getByText(/no key for the server yet/)).toBeTruthy()
    expect(relay.sent).toEqual([])
  })

  it('valid until: the time today, the date too on another day (Zürich clock)', () => {
    const now = Date.UTC(2026, 10, 21, 9, 0)
    expect(validUntilLabel(Date.UTC(2026, 10, 21, 20, 45), now)).toBe('21:45')
    expect(validUntilLabel(Date.UTC(2026, 10, 22, 7, 45), now)).toBe('22.11. 08:45')
    expect(validUntilLabel(NaN, now)).toBe('')
  })
})
