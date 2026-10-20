import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from '../Modal'
import CaptainToggle from '../CaptainToggle'
import { Button } from '../../ui/Button.jsx'
import { Input } from '../../ui/Input.jsx'
import { Select } from '../../ui/Select.jsx'
import { DateField } from '../../ui/DateField.jsx'
import { SectionHeader } from '../../ui/SectionHeader.jsx'
import { cn } from '../../ui/cn.js'

// "Edit home / away roster" in the scorer's match menu (Corrections), after
// the coin toss. Edits a copy of the players and bench officials; Save hands
// both, with the snapshots taken on opening, to the Scoreboard
// (handleSaveReopenedRoster), which validates, logs the changes and writes.
//
// One row per player or official, flat on the dialog with a hairline between
// them (it was a boxed card per player, "clumsy": the owner, 2026-10-20). The
// rows are a grid on the dialog's width (container query), as the setup
// roster (tailwind.css, "Roster and bench editors"):
//   phone    # | last name     | first name | remove
//            date of birth     | libero     | captain
//   >=560px  # | last | first | date of birth | libero | C | remove, under a
//            column head
// Bench: role + date of birth over last + first name + remove, so the names
// get a line; one line from 560 px. Every control is 44 px tall
// (courtside). The number, captain and remove columns are 44-48 px at any
// font size (a 2.75rem toggle in a 44 px track ran out of the row at 130 %),
// the date's in rem, so it keeps its digits at a large Android font.

const LIST = '@container border-y border-stone-200 divide-y divide-stone-100'
const ROW = 'grid items-center gap-1.5 py-2.5'
// The libero labels are short (-, L1, L2, LR): the date of birth gets the
// number's track too. The last name, which the scoresheet prints, gets the
// larger share of the names' line (4:3; 1:1 cut "Bachmann" at 360 px).
const PLAYER_GRID = cn(
  'grid-cols-[48px_minmax(0,4fr)_minmax(0,3fr)_44px]',
  "[grid-template-areas:'num_last_first_del'_'dob_dob_lib_cap']",
  '@[560px]:grid-cols-[56px_minmax(0,4fr)_minmax(0,3fr)_9rem_7rem_44px_44px]',
  "@[560px]:[grid-template-areas:'num_last_first_dob_lib_cap_del']"
)
// phone: role | date of birth (6.5rem + 44 px) over last | first | remove, the
// names about half the line each. Three on one line left the names 75 px (the
// removed in-match code had given them a line of their own after the emulator
// audit of 2026-10-14).
const BENCH_GRID = cn(
  'grid-cols-[minmax(0,5fr)_minmax(0,1fr)_6.5rem_44px]',
  "[grid-template-areas:'role_role_dob_dob'_'last_first_first_del']",
  '@[560px]:grid-cols-[15.5rem_minmax(0,1fr)_minmax(0,1fr)_9rem_44px]',
  "@[560px]:[grid-template-areas:'role_last_first_dob_del']"
)
// Column head: the one-line rows only.
const HEAD = 'hidden @[560px]:grid border-stone-200 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500'
const REMOVE = 'h-11 w-[44px] min-w-0 px-0'
// The date field at the kit's md size (its calendar button takes 36 px, not
// lg's 44, so the digits fit a phone's row) made as tall as an lg Input.
const DATE = 'h-11 rounded-xl border-stone-200 pl-2.5 text-base'
// CaptainToggle draws itself 40 px (inline): as tall as the row's inputs
// here, as wide as its 44 px track (a 2.75rem toggle ran out of the row at
// 130 %)
const CAPTAIN_CELL = 'flex justify-center [grid-area:cap] [&>button]:!h-11 [&>button]:!w-[44px] [&>button]:!min-w-[44px]'
// Names: 8 px of padding (the kit's 12 cut "Bachmann" on a phone)
const NAME = 'px-2'

export default function ReopenRosterModal({ teamKey, teamName, players, bench, onSave, onClose, t, benchRoles, toISODate }) {
  const [editingPlayers, setEditingPlayers] = useState(() =>
    players.map(p => ({ ...p })).sort((a, b) => (a.number || 0) - (b.number || 0))
  )
  const [editingBench, setEditingBench] = useState(() =>
    bench.filter(b => b.firstName || b.lastName || b.role).map(b => ({ ...b }))
  )
  const [snapshotPlayers] = useState(() =>
    players.map(p => ({ ...p }))
  )
  const [snapshotBench] = useState(() =>
    bench.filter(b => b.firstName || b.lastName || b.role).map(b => ({ ...b }))
  )

  const updatePlayer = (idx, field, value) => {
    setEditingPlayers(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p))
  }

  const addPlayer = () => {
    setEditingPlayers(prev => [...prev, {
      number: '', // must be entered (validated 1-99, unique) before saving
      firstName: '',
      lastName: '',
      dob: '',
      libero: '',
      isCaptain: false,
      isLfp: false
    }])
  }

  const removePlayer = (idx) => {
    setEditingPlayers(prev => prev.filter((_, i) => i !== idx))
  }

  const updateBench = (idx, field, value) => {
    setEditingBench(prev => prev.map((b, i) => i === idx ? { ...b, [field]: value } : b))
  }

  const addBench = () => {
    setEditingBench(prev => [...prev, { role: 'Coach', firstName: '', lastName: '', dob: '' }])
  }

  const removeBench = (idx) => {
    setEditingBench(prev => prev.filter((_, i) => i !== idx))
  }

  const removeLabel = t('scoreboard.reopenRoster.removePlayer', 'Remove')
  const firstNameLabel = t('scoreboard.reopenRoster.firstName', 'First name')
  const lastNameLabel = t('scoreboard.reopenRoster.lastName', 'Last name')
  const dobLabel = t('matchSetup.dateOfBirth', 'Date of birth')

  return (
    <Modal
      title={t('scoreboard.reopenRoster.title', { team: teamName })}
      open={true}
      onClose={onClose}
      width={760}
      // a column: the lists scroll, Cancel / Save stays in view (under a 65vh
      // list it fell below the dialog's edge on a phone and at 1280x720)
      panelStyle={{ display: 'flex', flexDirection: 'column' }}
    >
      <div className="ov-kit flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pb-1">
          {/* Players */}
          <SectionHeader
            as="h4"
            title={t('scoreboard.reopenRoster.players', 'Players')}
            count={editingPlayers.length}
            action={(
              <Button variant="ghost" size="sm" className="h-11 px-4 font-medium" onClick={addPlayer}>
                {t('scoreboard.reopenRoster.addPlayer', '+ Add player')}
              </Button>
            )}
          />
          <div role="list" className={cn(LIST, 'mt-2 mb-6')}>
            <div className={cn(HEAD, PLAYER_GRID, 'gap-1.5')} aria-hidden="true">
              <span className="text-center">#</span>
              <span>{lastNameLabel}</span>
              <span>{firstNameLabel}</span>
              <span>{dobLabel}</span>
              <span>{t('scoreboard.reopenRoster.libero', 'Libero')}</span>
              <span className="text-center">C</span>
              <span />
            </div>
            {editingPlayers.map((player, idx) => (
              <div role="listitem" key={player.id || `new-${idx}`} className={cn(ROW, PLAYER_GRID)}>
                <Input
                  size="lg"
                  type="number"
                  inputMode="numeric"
                  numeric
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  value={player.number || ''}
                  onChange={(e) => updatePlayer(idx, 'number', e.target.value === '' ? '' : (parseInt(e.target.value, 10) || 0))}
                  placeholder="#"
                  className="[grid-area:num] px-1 text-center text-lg font-semibold tabular-nums"
                />
                <Input
                  size="lg"
                  aria-label={lastNameLabel}
                  value={player.lastName || ''}
                  onChange={(e) => updatePlayer(idx, 'lastName', e.target.value)}
                  placeholder={lastNameLabel}
                  className={cn('[grid-area:last]', NAME)}
                />
                <Input
                  size="lg"
                  aria-label={firstNameLabel}
                  value={player.firstName || ''}
                  onChange={(e) => updatePlayer(idx, 'firstName', e.target.value)}
                  placeholder={firstNameLabel}
                  className={cn('[grid-area:first]', NAME)}
                />
                <DateField
                  size="md"
                  aria-label={dobLabel}
                  value={toISODate(player.dob)}
                  onChange={(v) => updatePlayer(idx, 'dob', v)}
                  wrapperClassName="[grid-area:dob]"
                  className={DATE}
                />
                {/* L1 / L2 / none (as in roster setup); a re-designated or unable
                    libero keeps that state unless changed explicitly */}
                <Select
                  size="lg"
                  block
                  aria-label={t('scoreboard.reopenRoster.libero', 'Libero')}
                  value={player.libero === true ? 'libero1' : (player.libero || '')}
                  onChange={(e) => updatePlayer(idx, 'libero', e.target.value)}
                  className="[grid-area:lib] pl-2.5"
                >
                  <option value="">-</option>
                  <option value="libero1">L1</option>
                  <option value="libero2">L2</option>
                  {player.libero === 'redesignated' && <option value="redesignated">LR</option>}
                  {player.libero === 'unable' && <option value="unable">{t('scoreboard.reopenRoster.liberoUnable', 'Unable')}</option>}
                </Select>
                <span className={CAPTAIN_CELL}>
                  <CaptainToggle
                    pressed={!!player.isCaptain}
                    number={player.number}
                    onToggle={() => updatePlayer(idx, 'isCaptain', !player.isCaptain)}
                  />
                </span>
                <span className="flex justify-center [grid-area:del]">
                  <Button variant="danger-outline" size="lg" className={REMOVE} aria-label={removeLabel} title={removeLabel} onClick={() => removePlayer(idx)}>
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </span>
              </div>
            ))}
          </div>

          {/* Bench officials */}
          <SectionHeader
            as="h4"
            title={t('scoreboard.reopenRoster.benchOfficials', 'Bench officials')}
            count={editingBench.length}
            action={(
              <Button variant="ghost" size="sm" className="h-11 px-4 font-medium" onClick={addBench}>
                {t('scoreboard.reopenRoster.addBenchOfficial', '+ Add bench official')}
              </Button>
            )}
          />
          <div role="list" className={cn(LIST, 'mt-2')}>
            <div className={cn(HEAD, BENCH_GRID, 'gap-1.5')} aria-hidden="true">
              <span>{t('matchSetup.role', 'Role')}</span>
              <span>{lastNameLabel}</span>
              <span>{firstNameLabel}</span>
              <span>{dobLabel}</span>
              <span />
            </div>
            {editingBench.map((staff, idx) => (
              <div role="listitem" key={idx} className={cn(ROW, BENCH_GRID)}>
                <Select
                  size="lg"
                  block
                  aria-label={t('matchSetup.role', 'Role')}
                  value={staff.role || 'Coach'}
                  onChange={(e) => updateBench(idx, 'role', e.target.value)}
                  className="[grid-area:role] pl-2.5"
                >
                  {/* "AC1 - Assistant coach 1", as in match setup: a phone's row
                      cuts the text, the code in front still tells AC1 from AC2 */}
                  {benchRoles.map(r => (
                    <option key={r.value} value={r.value}>
                      {r.key ? `${t(`benchRolesShort.${r.key}`)} - ${t(`benchRoles.${r.key}`, r.value)}` : r.value}
                    </option>
                  ))}
                </Select>
                <Input
                  size="lg"
                  aria-label={lastNameLabel}
                  value={staff.lastName || ''}
                  onChange={(e) => updateBench(idx, 'lastName', e.target.value)}
                  placeholder={lastNameLabel}
                  className={cn('[grid-area:last]', NAME)}
                />
                <Input
                  size="lg"
                  aria-label={firstNameLabel}
                  value={staff.firstName || ''}
                  onChange={(e) => updateBench(idx, 'firstName', e.target.value)}
                  placeholder={firstNameLabel}
                  className={cn('[grid-area:first]', NAME)}
                />
                <DateField
                  size="md"
                  aria-label={dobLabel}
                  value={toISODate(staff.dob)}
                  onChange={(v) => updateBench(idx, 'dob', v)}
                  wrapperClassName="[grid-area:dob]"
                  className={DATE}
                />
                <span className="flex justify-center [grid-area:del]">
                  <Button variant="danger-outline" size="lg" className={REMOVE} aria-label={removeLabel} title={removeLabel} onClick={() => removeBench(idx)}>
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Cancel / Save */}
        <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
          <Button variant="secondary" size="lg" className="h-11 min-w-[88px]" onClick={onClose}>
            {t('scoreboard.reopenRoster.cancel', 'Cancel')}
          </Button>
          <Button
            variant="positive"
            size="lg"
            className="h-11 min-w-[88px]"
            onClick={() => onSave(teamKey, editingPlayers, editingBench, snapshotPlayers, snapshotBench)}
          >
            {t('scoreboard.reopenRoster.save', 'Save changes')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
