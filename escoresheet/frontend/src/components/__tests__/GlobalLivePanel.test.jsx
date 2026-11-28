import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => lookup(key) ?? key }) }))

import GlobalLivePanel from '../options/GlobalLivePanel'
import { getLiveCode } from '../../utils/globalLive'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('GlobalLivePanel', () => {
  it('starts a live page: a code, its link and a way to turn it off', () => {
    render(<GlobalLivePanel />)
    fireEvent.click(screen.getByTestId('global-live-start'))
    const code = getLiveCode()
    expect(code).toMatch(/^[A-Z2-9]{8}$/)
    expect(screen.getByTestId('global-live-code').textContent).toBe(`${code.slice(0, 4)} ${code.slice(4)}`)
    expect(screen.getByTestId('global-live-url').textContent).toBe(`https://openvolley.app/tv/${code}`)
    fireEvent.click(screen.getByTestId('global-live-off'))
    expect(getLiveCode()).toBe(null)
    expect(screen.getByTestId('global-live-start')).toBeTruthy()
  })

  it('says beside the livescore opt-in that a listed code shows its listed courts only (owner decision 8)', () => {
    render(<GlobalLivePanel />)
    fireEvent.click(screen.getByTestId('global-live-start'))
    // in the (i) beside it (28.11.2026)
    fireEvent.click(within(screen.getByTestId('global-live-listed-hint')).getByRole('button'))
    expect(screen.getByTestId('global-live-listed-hint').querySelector('[data-info-panel]').textContent).toBe(en.globalLive.listedHint)
    expect(en.globalLive.listedHint).toMatch(/needs a code of its own/)
  })

  it('joins another device\'s code, and refuses a wrong one', () => {
    render(<GlobalLivePanel />)
    fireEvent.change(screen.getByTestId('global-live-input'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('global-live-join'))
    expect(screen.getByRole('alert').textContent).toBe(en.globalLive.badCode)
    expect(getLiveCode()).toBe(null)
    fireEvent.change(screen.getByTestId('global-live-input'), { target: { value: 'abcd 2345' } })
    fireEvent.click(screen.getByTestId('global-live-join'))
    expect(getLiveCode()).toBe('ABCD2345')
  })
})
