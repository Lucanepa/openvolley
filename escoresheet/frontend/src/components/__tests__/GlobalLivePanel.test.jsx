import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
    expect(screen.getByTestId('global-live-url').textContent).toBe(`https://livescore.openvolley.app/?t=${code}`)
    fireEvent.click(screen.getByTestId('global-live-off'))
    expect(getLiveCode()).toBe(null)
    expect(screen.getByTestId('global-live-start')).toBeTruthy()
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
