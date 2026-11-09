import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import JSZip from 'jszip'

// db/024: the club's licence lists. My club's upload (read in the browser,
// five fields sent), the list of people, "Add from club" with the gender rule
// for the players, and the team officials from anyone of the club (either
// gender) in the squad editor and a game's roster. Made-up people of VBC
// Musterdorf only.

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  club: { licences: vi.fn(), putLicences: vi.fn() },
  team: { squad: vi.fn(), clubPlayers: vi.fn(), games: vi.fn(), roster: vi.fn(), putRoster: vi.fn(), putSquad: vi.fn(), deleteRoster: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubApi: api.club, teamApi: api.team }))
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
import MyTeamsPanel from '../manage/MyTeamsPanel'
import ClubPlayerPickerModal from '../ClubPlayerPickerModal'

const VBCM = { id: 'c1', name: 'VBC Musterdorf' }
const okRes = (data, status = 200) => ({ data, error: null, status })
const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: null, gender: 'm' }
const TINA = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f' }
const SINA = { sv_number: '300001', last_name: 'Schreiber', first_name: 'Sina', dob: '1999-07-08', gender: 'f' }
// everyone of the club's three lists once (GET /api/team/:id/club-players `people`)
const PEOPLE = [
  { ...ANNA, lists: ['players'] },
  { ...MARCO, lists: ['players', 'coaches'] },
  { ...SINA, lists: ['scorers'] },
  { ...NOAH, lists: ['players'] },
  { ...TINA, lists: ['coaches'] }
]
const rowNamed = (rows, name) => rows.find((r) => r.textContent.includes(name))
const nameOf = (row) => row.querySelector('.font-medium.text-stone-900').textContent.trim()

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
    // the export stays only on this device: the page says to delete it there
    expect(screen.getByTestId('licences-delete-file')).toBeInTheDocument()
    expect(tr).toHaveBeenCalledWith('manage.licences.deleteFile', expect.objectContaining({ file: expect.any(String) }))
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
  const clubPlayers = { gender: 'm', players: [ANNA, MARCO, NOAH], people: PEOPLE }
  const team = { id: 'new-t-h1', name: 'VBC Musterdorf H1', players: [{ number: 1, first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '' }], staff: [] }

  it('"Add from club" offers the team\'s gender only and adds without duplicates', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} />)
    fireEvent.click(screen.getByTestId('squad-add-from-club'))
    const picker = await screen.findByTestId('club-picker')
    const rows = within(picker).getAllByTestId('club-picker-row')
    // Anna (f) is not offered to the men's team; Marco is in the squad already;
    // the scorers and coaches lists are not offered as players
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Probe Marco'), expect.stringContaining('Testmann Noah')])
    expect(within(rows[0]).getByRole('checkbox')).toBeDisabled()
    // no note about the gender in the picker (owner 2026-11-09: "can go away")
    expect(tr.mock.calls.map(([k]) => k).filter((k) => String(k).startsWith('clubPlayers.only'))).toEqual([])
    expect(picker.textContent).not.toMatch(/clubPlayers\.only/)
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

  it('an official from anyone of the club, of either gender: the role\'s row takes the person, nobody twice', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    const withCoach = { ...team, staff: [{ role: 'Coach', first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '' }] }
    render(<TeamEditor team={withCoach} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} />)
    fireEvent.click(screen.getByTestId('staff-add-from-club'))
    let picker = await screen.findByTestId('club-picker')
    expect(picker.dataset.mode).toBe('officials')
    // everyone of the three lists, the women too, for the men's team
    let rows = within(picker).getAllByTestId('club-picker-row')
    expect(rows.map(nameOf)).toEqual(['Beispiel Anna', 'Probe Marco', 'Schreiber Sina', 'Testmann Noah', 'Trainer Tina'])
    expect(rowNamed(rows, 'Trainer Tina').textContent).toContain('manage.licences.lists.coaches')
    // the first role nobody holds; Marco shows his role (the coach, by name)
    expect(screen.getByTestId('club-picker-role').value).toBe('Assistant Coach 1')
    expect(rowNamed(rows, 'Probe Marco').textContent).toContain('Coach')
    fireEvent.click(within(rowNamed(rows, 'Trainer Tina')).getByRole('radio'))
    expect(screen.getByTestId('club-picker-add')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(screen.getAllByTestId('staff-row')).toHaveLength(2))
    expect(ui.toasts).toContainEqual(['ok', 'clubPlayers.officialSet'])
    // the coach's role: Marco is already there; Anna takes his place
    fireEvent.click(screen.getByTestId('staff-add-from-club'))
    picker = await screen.findByTestId('club-picker')
    fireEvent.change(within(picker).getByTestId('club-picker-role'), { target: { value: 'Coach' } })
    expect(tr).toHaveBeenCalledWith('clubPlayers.roleNow', { name: 'Marco Probe' })
    rows = within(picker).getAllByTestId('club-picker-row')
    expect(within(rowNamed(rows, 'Probe Marco')).getByRole('radio')).toBeDisabled()
    expect(rowNamed(rows, 'Probe Marco').textContent).toContain('clubPlayers.inRole')
    fireEvent.click(within(rowNamed(rows, 'Beispiel Anna')).getByRole('radio'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(screen.queryByTestId('club-picker')).toBeNull())
    expect(screen.getAllByTestId('staff-row')).toHaveLength(2)
    // no gender rule for officials: a woman coaches the men's team
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(saveRoster).toHaveBeenCalledTimes(1))
    expect(saveRoster.mock.calls[0][0].staff).toEqual([
      { role: 'Coach', first_name: 'Anna', last_name: 'Beispiel', dob: '2004-05-06', license_number: '100001' },
      { role: 'Assistant Coach 1', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' }
    ])
  })

  it('a server before `people` offers the players list for the officials', async () => {
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={vi.fn()} clubPlayers={{ gender: 'm', players: [ANNA, MARCO] }} />)
    fireEvent.click(screen.getByTestId('staff-add-from-club'))
    const picker = await screen.findByTestId('club-picker')
    expect(within(picker).getAllByTestId('club-picker-row').map(nameOf)).toEqual(['Beispiel Anna', 'Probe Marco'])
  })

  it('shows the server\'s OV_WRONG_GENDER on the player\'s row', async () => {
    const saveRoster = vi.fn(async () => ({ data: null, status: 400, error: { code: 'OV_WRONG_GENDER', index: 0, message: 'x' } }))
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={{ gender: null, players: [] }} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(screen.getAllByText('manage.licences.wrongGender')).toHaveLength(2))
  })
})

describe('the picker', () => {
  it('players mode: several at once, the people it is given, no gender note', () => {
    const onPick = vi.fn()
    render(<ClubPlayerPickerModal open onClose={() => {}} onPick={onPick} players={[MARCO, NOAH]} isTaken={() => false} />)
    const rows = screen.getAllByTestId('club-picker-row')
    expect(rows).toHaveLength(2)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(within(rows[0]).getByRole('checkbox'))
    fireEvent.click(within(rows[1]).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    expect(onPick).toHaveBeenCalledWith([MARCO, NOAH])
  })

  it('officials mode: one person for one role, the scorer and the coach of the other gender offered', () => {
    const onPick = vi.fn()
    render(<ClubPlayerPickerModal
      open
      mode="officials"
      onClose={() => {}}
      onPick={onPick}
      players={PEOPLE}
      roles={[{ value: 'Coach', label: 'Coach' }, { value: 'Medic', label: 'Medic' }]}
      initialRole="Medic"
      rolesOf={(c) => (c.sv_number === MARCO.sv_number ? ['Medic'] : [])}
    />)
    const rows = screen.getAllByTestId('club-picker-row')
    expect(rows).toHaveLength(5)
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(within(rowNamed(rows, 'Probe Marco')).getByRole('radio')).toBeDisabled()
    // one at a time
    fireEvent.click(within(rowNamed(rows, 'Schreiber Sina')).getByRole('radio'))
    fireEvent.click(within(rowNamed(rows, 'Trainer Tina')).getByRole('radio'))
    expect(screen.getAllByRole('radio').filter((r) => r.checked)).toHaveLength(1)
    expect(tr).toHaveBeenCalledWith('clubPlayers.addAs', { role: 'Medic' })
    fireEvent.click(screen.getByTestId('club-picker-add'))
    expect(onPick).toHaveBeenCalledWith([PEOPLE[4]], 'Medic')
  })
})

describe('a game\'s roster with an official from the club (My teams)', () => {
  const squad = {
    id: 's1',
    name: 'VBC Musterdorf H1',
    players: [{ number: 1, first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '100003', active: true }, { number: 4, first_name: 'Noah', last_name: 'Testmann', dob: null, license_number: '100004', active: true }],
    staff: [{ role: 'Coach', first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '100003' }]
  }
  beforeEach(() => {
    api.team.squad.mockResolvedValue(okRes({ season: '2026/27', squad }))
    api.team.clubPlayers.mockResolvedValue(okRes({ team: { id: 't-h1', name: 'VBC Musterdorf H1' }, gender: 'm', players: [ANNA, MARCO, NOAH], people: PEOPLE }))
    api.team.games.mockResolvedValue(okRes({ games: [{ game_number: '950001', side: 'home', team_home: 'VBC Musterdorf H1', team_away: 'VBC Other H1', datetime: '2026-11-12T18:00:00', league: '2L Herren', hall: 'MSH', roster: null }] }))
    api.team.roster.mockResolvedValue(okRes({ roster: null }))
    api.team.putRoster.mockResolvedValue(okRes({ roster: { game_number: '950001' } }))
  })

  it('ticks the person in the role, unticks the one before, and sends a woman as the men\'s coach', async () => {
    render(<MyTeamsPanel teams={[{ id: 't-h1', name: 'VBC Musterdorf H1', club_name: 'VBC Musterdorf' }]} />)
    fireEvent.click(await screen.findByTestId('my-team-game-roster'))
    await screen.findByTestId('game-roster')
    fireEvent.click(await screen.findByTestId('game-official-from-club'))
    const picker = await screen.findByTestId('club-picker')
    expect(picker.dataset.mode).toBe('officials')
    fireEvent.change(within(picker).getByTestId('club-picker-role'), { target: { value: 'Coach' } })
    const rows = within(picker).getAllByTestId('club-picker-row')
    expect(rows).toHaveLength(5)
    expect(within(rowNamed(rows, 'Probe Marco')).getByRole('radio')).toBeDisabled()
    fireEvent.click(within(rowNamed(rows, 'Trainer Tina')).getByRole('radio'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(screen.queryByTestId('club-picker')).toBeNull())
    fireEvent.click(screen.getByTestId('game-roster-save'))
    await waitFor(() => expect(api.team.putRoster).toHaveBeenCalledTimes(1))
    const [, game, body] = api.team.putRoster.mock.calls[0]
    expect(game).toBe('950001')
    expect(body.staff).toEqual([{ role: 'Coach', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' }])
    expect(body.players.map((p) => p.last_name)).toEqual(['Probe', 'Testmann'])
  })
})
