import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))

// apiFrom('referee_database') resolves each page request when the test says so.
const api = vi.hoisted(() => ({ pending: [], empties: [], queries: [] }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const call = { order: [], gt: null, limit: null }
    const q = {
      select: () => q,
      contains: () => q,
      order: (col, opts) => { call.order.push([col, opts?.ascending !== false]); return q },
      gt: (col, v) => { call.gt = [col, v]; return q },
      limit: (n) => { call.limit = n; return q },
      then: (resolve, reject) => {
        api.queries.push(call)
        return new Promise(res => api.pending.push(res)).then(resolve, reject)
      }
    }
    return q
  }
}))

// Record each EmptyInset render (the "no referees" / offline message).
vi.mock('../../ui', async (importOriginal) => {
  const ui = await importOriginal()
  return { ...ui, EmptyInset: (props) => { api.empties.push(props.children); return ui.EmptyInset(props) } }
})

import RefereeSelector from '../RefereeSelector'

// The page request reaches the mock a microtask after the effect runs
async function resolvePage(n, result) {
  await act(async () => {
    await waitFor(() => expect(api.pending[n]).toBeTypeOf('function'))
    api.pending[n](result)
  })
}
import { PICKER_RESULTS } from '../pickerLayout'

const rows = [
  { id: 'a1', first_name: 'Anna', last_name: 'Müller', country: 'CHE', dob: '01.01.1990' },
  { id: 'b2', first_name: 'Jean-Philippe', last_name: 'Schwarzenbach-Delacroix', country: 'FRA', dob: '02.02.1985' },
  { id: 'c3', first_name: 'Luca', last_name: 'Keller', country: 'CHE', dob: '' }
]

// The box contract (pickerLayout.js): jsdom cannot measure, so assert the
// classes that fix the size. Width from the kit Modal, a fixed-height result area.
function expectFixedBox() {
  const panel = screen.getByRole('dialog')
  expect(panel.className).toMatch(/(^|\s)w-full(\s|$)/)
  expect(panel.className).toMatch(/(^|\s)max-w-md(\s|$)/)
  const list = screen.getByTestId('referee-picker-list')
  for (const cls of PICKER_RESULTS.split(' ')) expect(list.classList.contains(cls)).toBe(true)
  expect(PICKER_RESULTS).toMatch(/(^|\s)h-\S+/) // a height, not a max-height
  // nothing content-sized or animated on the way up to the panel
  for (let el = list; el && el !== document.body; el = el.parentElement) {
    expect(el.className || '').not.toMatch(/modal-wrapper-roll|animate-|transition-all/)
    expect(el.style.minWidth).toBe('')
    expect(el.style.maxWidth).toBe('')
    expect(el.style.transform).toBe('')
  }
}

describe('RefereeSelector', () => {
  beforeEach(() => { api.pending = []; api.queries = [] })

  it('keeps the same box while loading and after the referees arrive', async () => {
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    // loading: the skeleton fills the fixed result area
    expectFixedBox()
    expect(screen.getByTestId('referee-picker-list').querySelector('[role="status"]')).not.toBeNull()
    const before = screen.getByRole('dialog').className

    await resolvePage(0, { data: rows, error: null })
    expect(await screen.findByRole('button', { name: /Müller, Anna/ })).toBeInTheDocument()
    expectFixedBox()
    expect(screen.getByRole('dialog').className).toBe(before)
    expect(screen.getByTestId('referee-picker-list').querySelector('[role="status"]')).toBeNull()
  })

  it('an empty database and a no-match search use the same box', async () => {
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: [], error: null })
    expect(screen.getByText('refereeSelector.noRefereeHistory')).toBeInTheDocument()
    expectFixedBox()
  })

  it('a network failure says to connect, in the same box', async () => {
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: null, error: { message: 'offline', status: 0, network: true } })
    expect(screen.getByText('refereeSelector.connectToInternet')).toBeInTheDocument()
    expectFixedBox()
  })

  it('focuses the search, filters by name, and picks a referee', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<RefereeSelector open onClose={onClose} onSelect={onSelect} />)
    await resolvePage(0, { data: rows, error: null })
    const search = screen.getByRole('searchbox', { name: 'refereeSelector.searchReferees' })
    expect(document.activeElement).toBe(search)

    fireEvent.change(search, { target: { value: 'kel' } })
    expect(screen.queryByRole('button', { name: /Müller/ })).toBeNull()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('refereeSelector.noRefereesFound')).toBeInTheDocument()
    expectFixedBox()

    fireEvent.change(search, { target: { value: 'kel' } })
    fireEvent.click(screen.getByRole('button', { name: /Keller, Luca/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Luca', lastName: 'Keller', country: 'CHE' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape closes it', async () => {
    const onClose = vi.fn()
    render(<RefereeSelector open onClose={onClose} onSelect={() => {}} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('a reopen starts on the skeleton, not on the last open\'s "no referees"', async () => {
    const { rerender } = render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: [], error: null })
    expect(screen.getByText('refereeSelector.noRefereeHistory')).toBeInTheDocument()
    rerender(<RefereeSelector open={false} onClose={() => {}} onSelect={() => {}} />)
    // act() flushes effects before we can look, so count the empty messages
    // rendered by the reopen itself: its first frame must be the skeleton
    api.empties = []
    rerender(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    expect(api.empties).toEqual([])
    expect(screen.queryByText('refereeSelector.noRefereeHistory')).toBeNull()
    expect(screen.getByTestId('referee-picker-list').querySelector('[role="status"]')).not.toBeNull()
    expectFixedBox()
    await resolvePage(1, { data: rows, error: null })
    expect(await screen.findByRole('button', { name: /Müller, Anna/ })).toBeInTheDocument()
  })

  it('reads the whole directory past the 1000-row cap and lists it by last name', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `id${String(i).padStart(4, '0')}`, first_name: `F${i}`, last_name: `Name${String(i).padStart(4, '0')}`, country: 'CHE', dob: ''
    }))
    // The 1001st row by id sorts first by last name
    const page2 = [{ id: 'id9999', first_name: 'Beat', last_name: 'Aebi', country: 'CHE', dob: '' }]
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: page1, error: null })
    expect(api.queries[0]).toEqual({ order: [['id', true]], gt: null, limit: 1000 })
    await resolvePage(1, { data: page2, error: null })
    expect(api.queries[1].gt).toEqual(['id', 'id0999'])
    expect(api.pending).toHaveLength(2)

    // Plain DOM reads: role queries over 1001 rows are slow in jsdom
    const list = screen.getByTestId('referee-picker-list')
    await waitFor(() => expect(list.textContent).toContain('Aebi'))
    const names = [...list.querySelectorAll('button')].map(b => b.textContent)
    expect(names).toHaveLength(1001)
    expect(names[0]).toMatch(/Aebi/)
    expect(names[1]).toMatch(/Name0000/)
  })

  it('renders nothing while closed', () => {
    render(<RefereeSelector open={false} onClose={() => {}} onSelect={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.pending).toHaveLength(0)
  })
})

describe('legacy roll-in animation (styles.css)', () => {
  // The menus that still use .modal-wrapper-roll-down/up must not scale: the
  // old keyframes ran scale(1.2) -> scale(1.5) and then snapped back to 1.
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8')
  for (const name of ['rollDown', 'rollUp']) {
    it(`@keyframes ${name} has no scale and ends at the real size`, () => {
      const m = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\n)\\}`))
      expect(m).not.toBeNull()
      expect(m[1]).not.toMatch(/scale/)
      expect(m[1]).toMatch(/to\s*\{[^}]*transform:\s*none/)
    })
  }
})
