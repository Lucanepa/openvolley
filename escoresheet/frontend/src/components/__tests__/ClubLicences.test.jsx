import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import JSZip from 'jszip'

// db/024: the club's licence lists. My club's upload (read in the browser,
// five fields sent), the list of people, and "Add from club" with the gender
// rule in the squad editor. Made-up people of VBC Musterdorf only.

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({ club: { licences: vi.fn(), putLicences: vi.fn() } }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubApi: api.club }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import ClubLicencesSection from '../manage/ClubLicencesSection'
import TeamEditor from '../manage/TeamEditor'

const VBCM = { id: 'c1', name: 'VBC Musterdorf' }
const okRes = (data, status = 200) => ({ data, error: null, status })
const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: null, gender: 'm' }

/** A tiny Italian club export: title, blank, header row 3, two people, columns that must stay behind. */
async function exportFile() {
  const strings = ['Lista', 'N. SV', 'Cognome', 'Nome', 'Data di nascita', 'Sesso', 'Indirizzo E-mail', 'Beispiel', 'Anna', 'D', 'anna@example.ch', 'Probe', 'Marco', 'U', 'marco@example.ch']
  const s = (v) => strings.indexOf(v)
  const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${s(v)}</v></c>`)
  const row = (r, values) => `<row r="${r}">${values.map((v, i) => cell(`${'ABCDEFG'[i]}${r}`, v)).join('')}</row>`
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/sharedStrings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((x) => `<si><t>${x}</t></si>`).join('')}</sst>`)
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[
    row(1, ['Lista']),
    row(3, ['N. SV', 'Cognome', 'Nome', 'Data di nascita', 'Sesso', 'Indirizzo E-mail']),
    row(4, [100001, 'Beispiel', 'Anna', 38113, 'D', 'anna@example.ch']),
    row(5, [100003, 'Probe', 'Marco', 37197, 'U', 'marco@example.ch'])
  ].join('')}</sheetData></worksheet>`)
  return new File([await zip.generateAsync({ type: 'uint8array' })], 'giocatori.xlsx')
}

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.club.licences.mockResolvedValue(okRes({
    season: '2026/27',
    lists: { players: { count: 2, imported_at: '2026-11-09T08:00:00Z', imported_by_name: 'Clara Club' }, scorers: { count: 0, imported_at: null, imported_by_name: null }, coaches: { count: 1, imported_at: '2026-11-09T08:05:00Z', imported_by_name: 'Clara Club' } },
    people: [
      { ...ANNA, lists: ['players'], teams: [{ id: 't-d1', name: 'VBC Musterdorf D1' }] },
      { ...MARCO, lists: ['players', 'coaches'], teams: [{ id: 't-h1', name: 'VBC Musterdorf H1' }] }
    ]
  }))
})

describe('My club → Licences', () => {
  it('reads the export in the browser, shows the preview and saves the five fields only', async () => {
    api.club.putLicences.mockResolvedValue(okRes({ list: 'players', count: 2, imported_at: '2026-11-09T09:00:00Z' }))
    render(<ClubLicencesSection club={VBCM} />)
    await screen.findByTestId('licences-people')
    fireEvent.change(screen.getByTestId('licences-file'), { target: { files: [await exportFile()] } })
    const preview = await screen.findByTestId('licences-preview')
    expect(tr).toHaveBeenCalledWith('manage.licences.previewCount', { count: 2 })
    expect(within(preview).getByText(/Beispiel Anna · 100001/)).toBeInTheDocument()
    expect(preview.textContent).not.toContain('example.ch')
    fireEvent.click(screen.getByTestId('licences-save'))
    await waitFor(() => expect(api.club.putLicences).toHaveBeenCalledTimes(1))
    const [clubId, list, people] = api.club.putLicences.mock.calls[0]
    expect([clubId, list]).toEqual(['c1', 'players'])
    expect(people).toEqual([
      { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' },
      { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
    ])
    await waitFor(() => expect(ui.toasts.map((x) => x[1])).toContain('manage.licences.saved'))
    expect(screen.queryByTestId('licences-preview')).toBeNull()
  })

  it('refuses a file that is not a club export, and saves nothing', async () => {
    render(<ClubLicencesSection club={VBCM} />)
    await screen.findByTestId('licences-lists')
    fireEvent.change(screen.getByTestId('licences-file'), { target: { files: [new File(['N. SV;Cognome'], 'list.csv')] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('manage.licences.notXlsx'))
    expect(api.club.putLicences).not.toHaveBeenCalled()
  })

  it('lists each person once with lists and teams; filters by list, gender and name', async () => {
    render(<ClubLicencesSection club={VBCM} />)
    const list = await screen.findByTestId('licences-people')
    expect(within(list).getByText('Beispiel Anna')).toBeInTheDocument()
    expect(within(list).getByText('VBC Musterdorf H1')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('licences-filter-list'), { target: { value: 'coaches' } })
    expect(within(screen.getByTestId('licences-people')).queryByText('Beispiel Anna')).toBeNull()
    fireEvent.change(screen.getByTestId('licences-filter-list'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('licences-filter-gender'), { target: { value: 'f' } })
    expect(within(screen.getByTestId('licences-people')).queryByText('Probe Marco')).toBeNull()
    fireEvent.change(screen.getByTestId('licences-filter-gender'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('licences-search'), { target: { value: '100003' } })
    expect(within(screen.getByTestId('licences-people')).getAllByText(/Probe Marco|Beispiel Anna/).map((n) => n.textContent)).toEqual(['Probe Marco'])
  })

  it('deletes a list after asking (an empty upload)', async () => {
    api.club.putLicences.mockResolvedValue(okRes({ list: 'players', count: 0 }))
    render(<ClubLicencesSection club={VBCM} />)
    await screen.findByTestId('licences-lists')
    fireEvent.click(screen.getAllByTestId('licences-delete')[0])
    await waitFor(() => expect(api.club.putLicences).toHaveBeenCalledWith('c1', 'players', []))
  })
})

describe('the squad editor with the club\'s players (My teams)', () => {
  const clubPlayers = { gender: 'm', players: [ANNA, MARCO, NOAH] }
  const team = { id: 'new-t-h1', name: 'VBC Musterdorf H1', players: [{ number: 1, first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '' }], staff: [] }

  it('"Add from club" offers the team\'s gender only and adds without duplicates', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} />)
    fireEvent.click(screen.getByTestId('squad-add-from-club'))
    const picker = await screen.findByTestId('club-picker')
    const rows = within(picker).getAllByTestId('club-picker-row')
    // Anna (f) is not offered to the men's team; Marco is in the squad already
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Probe Marco'), expect.stringContaining('Testmann Noah')])
    expect(within(rows[0]).getByRole('checkbox')).toBeDisabled()
    expect(tr).toHaveBeenCalledWith('clubPlayers.onlyMen', { count: 1 })
    fireEvent.click(within(rows[1]).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(screen.getAllByTestId('player-row')).toHaveLength(2))
    expect(screen.getAllByLabelText('savedTeams.license').map((i) => i.value)).toEqual(['', '100004'])
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(saveRoster).toHaveBeenCalledTimes(1))
    expect(saveRoster.mock.calls[0][0].players.map((p) => p.license_number)).toEqual([null, '100004'])
  })

  it('refuses to save a player the club has with the other gender, as the server does', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    render(<TeamEditor team={{ ...team, players: [...team.players, { number: 2, first_name: 'Anna', last_name: 'Beispiel', license_number: '100001' }] }} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(screen.getAllByText('manage.licences.wrongGender').length).toBeGreaterThan(0))
    expect(saveRoster).not.toHaveBeenCalled()
  })

  it('shows the server\'s OV_WRONG_GENDER on the player\'s row', async () => {
    const saveRoster = vi.fn(async () => ({ data: null, status: 400, error: { code: 'OV_WRONG_GENDER', index: 0, message: 'x' } }))
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={{ gender: null, players: [] }} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(screen.getAllByText('manage.licences.wrongGender')).toHaveLength(2))
  })
})
