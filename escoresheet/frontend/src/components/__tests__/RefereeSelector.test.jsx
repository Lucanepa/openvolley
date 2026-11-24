import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))

// apiFrom('referee_database') resolves each request when the test says so.
const api = vi.hoisted(() => ({ pending: [], empties: [], queries: [] }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const call = { order: [], gt: null, limit: null, ilike: [], contains: null }
    const q = {
      select: () => q,
      contains: (col, v) => { call.contains = [col, v]; return q },
      ilike: (col, v) => { call.ilike.push([col, v]); return q },
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

import RefereeSelector, { prefixPattern, REFEREE_PICKER_LIMIT, REFEREE_SEARCH_DEBOUNCE_MS } from '../RefereeSelector'

// The page request reaches the mock a microtask after the effect runs
async function resolvePage(n, result) {
  await act(async () => {
    await waitFor(() => expect(api.pending[n]).toBeTypeOf('function'))
    api.pending[n](result)
  })
}
import { PICKER_RESULTS } from '../pickerLayout'

// the directory's rows since db/048: no date of birth
const rows = [
  { id: 'a1', first_name: 'Anna', last_name: 'Müller', country: 'CHE' },
  { id: 'b2', first_name: 'Jean-Philippe', last_name: 'Schwarzenbach-Delacroix', country: 'FRA' },
  { id: 'c3', first_name: 'Luca', last_name: 'Keller', country: 'CHE' }
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

  it('two directory rows with one name: keyed by their id, a licence number shown where a row has one, never a date of birth', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onSelect = vi.fn()
    render(<RefereeSelector open onClose={() => {}} onSelect={onSelect} />)
    await resolvePage(0, { data: [
      // an older server still answering a date of birth: never shown or picked
      { id: 's1', first_name: 'Sam', last_name: 'Sample', country: 'CHE', dob: '01.01.1980' },
      { id: 's2', first_name: 'Sam', last_name: 'Sample', country: 'CHE', licence: '123456' },
      { id: 's3', first_name: 'Sam', last_name: 'Sample', country: 'CHE' },
      ...rows
    ], error: null })
    const same = screen.getAllByRole('button', { name: /Sample, Sam/ })
    expect(same).toHaveLength(3)
    expect(same[0].textContent).toBe('Sample, Sam')
    expect(same[1]).toHaveTextContent('123456')
    expect(same[2].textContent).toBe('Sample, Sam')
    for (const b of same) expect(b.textContent).not.toMatch(/1980/)
    // a name of its own shows no detail
    expect(screen.getByRole('button', { name: /Müller, Anna/ }).textContent).toBe('Müller, Anna')
    fireEvent.click(same[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).not.toHaveProperty('dob')
    expect(errors.mock.calls.some(([m]) => /same key/i.test(String(m)))).toBe(false)
    errors.mockRestore()
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

  // PERM-07 (audit 2611): the picker read the whole directory (selectAll),
  // which gave up past 200,000 rows and left it empty; it now searches
  it('asks the server for the first referees by last name, never the whole directory, and says to type for more', async () => {
    const page = Array.from({ length: REFEREE_PICKER_LIMIT }, (_, i) => ({
      id: `id${String(i).padStart(4, '0')}`, first_name: `F${i}`, last_name: `Name${String(999 - i).padStart(4, '0')}`, country: 'CHE'
    }))
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: page, error: null })
    expect(api.queries[0]).toEqual({ order: [['last_name', true]], gt: null, limit: REFEREE_PICKER_LIMIT, ilike: [], contains: ['sport_type', '["indoor"]'] })
    const list = screen.getByTestId('referee-picker-list')
    await waitFor(() => expect(list.textContent).toContain('Name0900'))
    const names = [...list.querySelectorAll('button')].map(b => b.textContent)
    expect(names).toHaveLength(REFEREE_PICKER_LIMIT)
    expect(names[0]).toMatch(/Name0900/)
    expect(screen.getByTestId('referee-picker-more').textContent).toBe('refereeSelector.typeToSearch')
    await new Promise(r => setTimeout(r, REFEREE_SEARCH_DEBOUNCE_MS + 50))
    expect(api.pending).toHaveLength(1) // one request, no paging
  })

  it('a short directory shows no "type for more"', async () => {
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: rows, error: null })
    await screen.findByRole('button', { name: /Müller, Anna/ })
    expect(screen.queryByTestId('referee-picker-more')).toBeNull()
  })

  it('typing searches the server by name prefix (last and first name), each with the limit, and lists the answers once, by last name', async () => {
    const onSelect = vi.fn()
    render(<RefereeSelector open onClose={() => {}} onSelect={onSelect} />)
    await resolvePage(0, { data: rows, error: null })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'be' } })
    await waitFor(() => expect(api.pending).toHaveLength(3), { timeout: 2000 })
    expect(api.queries.slice(1).map(q => [q.ilike, q.limit, q.order])).toEqual([
      [[['last_name', 'be*']], REFEREE_PICKER_LIMIT, [['last_name', true]]],
      [[['first_name', 'be*']], REFEREE_PICKER_LIMIT, [['last_name', true]]]
    ])
    const beat = { id: 'x1', first_name: 'Beat', last_name: 'Zürcher', country: 'CHE' }
    const bern = { id: 'x2', first_name: 'Anna', last_name: 'Bernasconi', country: 'ITA' }
    await act(async () => {
      api.pending[1]({ data: [bern], error: null })
      api.pending[2]({ data: [beat, bern], error: null })
    })
    const list = screen.getByTestId('referee-picker-list')
    await waitFor(() => expect(list.textContent).toContain('Zürcher'))
    expect([...list.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Bernasconi, Anna', 'Zürcher, Beat'])
    fireEvent.click(screen.getByRole('button', { name: /Zürcher, Beat/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Beat', lastName: 'Zürcher' }))
  })

  it('"Last First" also asks for the last name by its first word; a failed search says so like a failed load', async () => {
    render(<RefereeSelector open onClose={() => {}} onSelect={() => {}} />)
    await resolvePage(0, { data: rows, error: null })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Keller  Lu' } })
    await waitFor(() => expect(api.pending).toHaveLength(4), { timeout: 2000 })
    expect(api.queries.slice(1).map(q => q.ilike)).toEqual([[['last_name', 'Keller Lu*']], [['first_name', 'Keller Lu*']], [['last_name', 'Keller*']]])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      api.pending[1]({ data: [], error: null })
      api.pending[2]({ data: null, error: { message: 'offline', status: 0, network: true } })
      api.pending[3]({ data: [], error: null })
    })
    await waitFor(() => expect(screen.getByText('refereeSelector.noRefereesFound')).toBeInTheDocument())
    errors.mockRestore()
  })

  it('prefixPattern: the typed text as a prefix, without the pattern characters', () => {
    expect(prefixPattern('kel')).toBe('kel*')
    expect(prefixPattern('  Müller  ')).toBe('Müller*')
    expect(prefixPattern('a%b_c*d\\e')).toBe('abcde*')
    expect(prefixPattern('Van   der')).toBe('Van der*')
    expect(prefixPattern('%')).toBeNull()
    expect(prefixPattern('')).toBeNull()
    expect(prefixPattern(null)).toBeNull()
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
      // it animates translate, so a menu's own transform (scale(1.5)) holds
      // while it runs (owner 15.11: the menu "reopened a little bigger")
      expect(m[1]).not.toMatch(/transform:/)
      expect(m[1]).toMatch(/to\s*\{[^}]*translate:\s*none/)
    })
  }
})
