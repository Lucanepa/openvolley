import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// t with the fallback and its {{placeholders}}, as i18next fills them
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => String(typeof fallback === 'string' ? fallback : key)
      .replace(/\{\{(\w+)\}\}/g, (m, name) => (options && name in options ? String(options[name]) : m)),
    i18n: { language: 'en' }
  })
}))

import StartupConnectivityModal from '../StartupConnectivityModal'
import { internetNumbers } from '../../utils/internetCheck'

// The start check's "Internet" row (owner 28.11.2026): the measured round
// trip and download beside a verdict, good / slow / offline, from the
// dialog's first frame; the heading and the countdown wait for it as for
// every other row.

const ALL_CONNECTED = { api: 'connected', server: 'connected', websocket: 'connected', scoreboard: 'connected', match: 'no_match', db: 'connected', supabase: 'connected' }
const ROWS = ['db', 'supabase', 'api', 'server', 'websocket', 'scoreboard', 'internet']

const dialog = () => screen.getByRole('dialog')
const rowKeys = () => [...dialog().querySelectorAll('[data-service]')].map((r) => r.dataset.service)
const row = (key) => dialog().querySelector(`[data-service="${key}"]`)
const heading = () => screen.getByRole('heading').textContent
const props = { open: true, onDismiss: () => {}, onGoOffline: () => {} }
const t = (key, fallback, options) => String(fallback).replace(/\{\{(\w+)\}\}/g, (m, n) => (options && n in options ? String(options[n]) : m))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('StartupConnectivityModal: the Internet row', () => {
  it('is there from the first frame, last, measuring; it holds the heading and the countdown', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    render(<StartupConnectivityModal {...props} onDismiss={onDismiss} connectionStatuses={ALL_CONNECTED} internet={{ status: 'connecting' }} />)
    expect(rowKeys()).toEqual(ROWS)
    expect(row('internet')).toHaveTextContent('Internet')
    expect(row('internet')).toHaveTextContent('Measuring')
    expect(heading()).toBe('Connecting...')
    // scoring is never held: Dismiss is there while it measures
    expect(screen.getByRole('button', { name: /^Dismiss/ })).toBeInTheDocument()
    expect(screen.queryByText(/\(\d+s\)/)).toBeNull()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('good: the verdict with its numbers, every service connected, the countdown runs', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onDismiss = vi.fn()
    const { rerender } = render(<StartupConnectivityModal {...props} onDismiss={onDismiss} connectionStatuses={ALL_CONNECTED} internet={{ status: 'connecting' }} />)
    const firstRow = row('internet')
    rerender(<StartupConnectivityModal {...props} onDismiss={onDismiss} connectionStatuses={ALL_CONNECTED} internet={{ status: 'good', rttMs: 38, mbps: 24 }} />)
    expect(row('internet')).toBe(firstRow) // the same row, filled
    expect(row('internet').dataset.status).toBe('good')
    expect(row('internet')).toHaveTextContent('Good')
    expect(screen.getByTestId('internet-numbers')).toHaveTextContent('38 ms, 24 Mbit/s')
    expect(row('internet').innerHTML).toMatch(/text-green-700/)
    expect(heading()).toBe('All services connected!')
    expect(screen.getByText('(5s)')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('slow: amber, never red; the heading is neutral and the synced check still closes by itself', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal {...props} connectionStatuses={ALL_CONNECTED} internet={{ status: 'slow', rttMs: 620, mbps: 0.4 }} />)
    expect(row('internet')).toHaveTextContent('Slow')
    expect(screen.getByTestId('internet-numbers')).toHaveTextContent('620 ms, 0.4 Mbit/s')
    expect(row('internet').innerHTML).toMatch(/text-amber-700/)
    expect(row('internet').innerHTML).not.toMatch(/text-red/)
    expect(heading()).toBe('Connection status')
    expect(screen.getByText('(5s)')).toBeInTheDocument()
  })

  it('offline at a venue: quiet, and the local server still carries the match', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(
      <StartupConnectivityModal
        {...props}
        connectionStatuses={{ ...ALL_CONNECTED, supabase: 'offline', api: 'disconnected', server: 'disconnected', scoreboard: 'disconnected' }}
        internet={{ status: 'offline', rttMs: null, mbps: null }}
      />
    )
    expect(row('internet')).toHaveTextContent('Offline')
    expect(row('internet').innerHTML).toMatch(/text-stone-500/)
    expect(screen.queryByTestId('internet-numbers')).toBeNull()
    expect(heading()).toBe('Connected via local server')
  })

  it('not measured here (no cloud on this page): a dash, and it does not hold the heading', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal {...props} connectionStatuses={ALL_CONNECTED} internet={{ status: 'not_checked' }} />)
    expect(row('internet')).toHaveTextContent('Not measured')
    expect(heading()).toBe('All services connected!')
  })

  it('without a measurement given, no Internet row (the six services as before)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal {...props} connectionStatuses={ALL_CONNECTED} />)
    expect(rowKeys()).toEqual(ROWS.slice(0, 6))
    expect(heading()).toBe('All services connected!')
  })

  it('says what it measured (title) and that nothing is stored', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<StartupConnectivityModal {...props} connectionStatuses={ALL_CONNECTED} internet={{ status: 'good', rttMs: 38, mbps: 24 }} />)
    expect(row('internet').getAttribute('title')).toMatch(/OpenVolley server.*median of 3.*256 KB.*Nothing is stored/)
  })
})

describe('internetNumbers', () => {
  it('round trip and throughput, one decimal below 10 Mbit/s', () => {
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: 24 }, t, 'en')).toBe('38 ms, 24 Mbit/s')
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: 3.5 }, t, 'en')).toBe('38 ms, 3.5 Mbit/s')
    expect(internetNumbers({ status: 'slow', rttMs: 900, mbps: 0.04 }, t, 'en')).toBe('900 ms, < 0.1 Mbit/s')
  })

  it('in the device language: a decimal comma in German and French', () => {
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: 3.5 }, t, 'de')).toBe('38 ms, 3,5 Mbit/s')
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: 3.5 }, t, 'fr')).toBe('38 ms, 3,5 Mbit/s')
  })

  it('the round trip alone with data saver on, or when the server gave no download number', () => {
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: null, saveData: true }, t, 'en')).toBe('38 ms, data saver: no download')
    expect(internetNumbers({ status: 'good', rttMs: 38, mbps: null }, t, 'en')).toBe('38 ms')
  })

  it('no answer in time: says how long it waited', () => {
    expect(internetNumbers({ status: 'slow', rttMs: null, noAnswerMs: 1500 }, t, 'en')).toBe('no answer in 1.5 s')
  })

  it('offline or not measured: no numbers', () => {
    expect(internetNumbers({ status: 'offline', rttMs: null }, t, 'en')).toBe('')
    expect(internetNumbers({ status: 'not_checked' }, t, 'en')).toBe('')
  })
})
