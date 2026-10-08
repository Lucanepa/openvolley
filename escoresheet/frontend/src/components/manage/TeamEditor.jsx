import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Plus, Trash2, X } from 'lucide-react'
import { savedTeamsApi, errorKeyOf } from '../../lib/accountApi'
import { apiFrom } from '../../lib/apiClient'
import { selectAll } from '../../lib/selectAll'
import { STAFF_ROLES, validateSavedRoster, MAX_PLAYERS, MAX_STAFF, sportOf } from '../../domain/savedTeams'
import { InlineError } from './common'
import { Button, DateField, Field, Input, Select, Checkbox, Switch, SectionHeader, EmptyInset, IconButton, confirmDialog, toast, cn } from '../../ui'

const HEX = /^#[0-9a-f]{6}$/i
const STAFF_ROLE_KEYS = {
  Coach: 'benchRoles.coach',
  'Assistant Coach 1': 'benchRoles.assistantCoach1',
  'Assistant Coach 2': 'benchRoles.assistantCoach2',
  Physiotherapist: 'benchRoles.physiotherapist',
  Medic: 'benchRoles.medic'
}

let keySeq = 0
const nextKey = () => `k${++keySeq}`

function toPlayerDraft(p) {
  return {
    key: nextKey(),
    id: p?.id,
    number: p?.number ?? '',
    first_name: p?.first_name || '',
    last_name: p?.last_name || '',
    dob: p?.dob || '',
    license_number: p?.license_number || '',
    is_libero: !!p?.is_libero,
    is_captain: !!p?.is_captain,
    active: p?.active !== false
  }
}
function toStaffDraft(s) {
  return {
    key: nextKey(),
    id: s?.id,
    role: STAFF_ROLES.includes(s?.role) ? s.role : 'Coach',
    first_name: s?.first_name || '',
    last_name: s?.last_name || '',
    dob: s?.dob || '',
    license_number: s?.license_number || ''
  }
}

// ── Beach (docs/beach-saved-teams-spec.md 3.6): a pair in two fixed slots, plus an optional coach ──
const BEACH_SLOTS = [1, 2]

function toSlotDraft(p, number) {
  return {
    number,
    id: p?.id,
    first_name: p?.first_name || '',
    last_name: p?.last_name || '',
    dob: p?.dob || '',
    license_number: p?.license_number || '',
    country: p?.country || ''
  }
}

/** Saved players → the two slots: the player numbered n fills slot n (others the first free slot). */
export function beachSlotsFromPlayers(players) {
  const list = Array.isArray(players) ? players.filter(Boolean) : []
  const slots = BEACH_SLOTS.map(n => list.find(p => Number(p.number) === n) || null)
  for (const p of list) {
    if (slots.includes(p)) continue
    const free = slots.indexOf(null)
    if (free === -1) break
    slots[free] = p
  }
  return BEACH_SLOTS.map((n, i) => toSlotDraft(slots[i], n))
}

function toCoachDraft(staff) {
  const s = (Array.isArray(staff) ? staff : []).find(x => x?.role === 'Coach')
  return s ? { id: s.id, first_name: s.first_name || '', last_name: s.last_name || '', dob: s.dob || '', license_number: s.license_number || '' } : null
}

const emptyCoach = () => ({ first_name: '', last_name: '', dob: '', license_number: '' })

/** Beach slots + coach → the PUT roster body: the slots with a name, and the coach when named. */
export function draftToBeachRosterBody(slots, coach) {
  const clean = (v) => String(v ?? '').trim()
  const players = (slots || [])
    .filter(p => clean(p.first_name) || clean(p.last_name))
    .map(p => {
      const row = {
        number: p.number,
        first_name: clean(p.first_name),
        last_name: clean(p.last_name),
        dob: clean(p.dob) || null,
        license_number: clean(p.license_number) || null,
        country: clean(p.country).toUpperCase() || null
      }
      if (p.id) row.id = p.id
      return row
    })
  const staff = coach && (clean(coach.first_name) || clean(coach.last_name))
    ? [{
        ...(coach.id ? { id: coach.id } : {}),
        role: 'Coach',
        first_name: clean(coach.first_name),
        last_name: clean(coach.last_name),
        dob: clean(coach.dob) || null,
        license_number: clean(coach.license_number) || null
      }]
    : []
  return { players, staff }
}

/** Draft rows → the PUT roster body (sort_order is set by the server). */
export function draftToRosterBody(players, staff) {
  const clean = (v) => String(v ?? '').trim()
  return {
    players: players.map(p => {
      const n = clean(p.number)
      const row = {
        number: n === '' ? null : Number(n),
        first_name: clean(p.first_name),
        last_name: clean(p.last_name),
        dob: clean(p.dob) || null,
        license_number: clean(p.license_number) || null,
        is_libero: !!p.is_libero,
        is_captain: !!p.is_captain,
        active: !!p.active
      }
      if (p.id) row.id = p.id
      return row
    }),
    staff: staff.map(s => {
      const row = {
        role: s.role,
        first_name: clean(s.first_name),
        last_name: clean(s.last_name),
        dob: clean(s.dob) || null,
        license_number: clean(s.license_number) || null
      }
      if (s.id) row.id = s.id
      return row
    })
  }
}

// Small labels: shown above each input on phones (one input per row), and
// as the column heads from sm on.
const CELL_LABEL = 'mb-0.5 block text-[11px] font-medium text-stone-500 sm:sr-only'
const HEAD = 'hidden sm:grid text-[11px] font-bold uppercase tracking-wide text-stone-500'

/**
 * Edit one saved team: its fields (PATCH), its players and team officials
 * (PUT roster) or delete it. Writes need a connection; the parent refreshes
 * the offline cache after each one.
 */
export default function TeamEditor({ team, competition, online, onBack, onChanged, onDeleted }) {
  const { t } = useTranslation()
  const beach = sportOf(competition) === 'beach'
  const [fields, setFields] = useState(() => ({
    name: team.name || '',
    short_name: team.short_name || '',
    club: team.club || '',
    color: team.color || '',
    svrz_team_name: team.svrz_team_name || ''
  }))
  const [players, setPlayers] = useState(() => (team.players || []).map(toPlayerDraft))
  const [staff, setStaff] = useState(() => (team.staff || []).map(toStaffDraft))
  const [slots, setSlots] = useState(() => beachSlotsFromPlayers(team.players))
  const [coach, setCoach] = useState(() => toCoachDraft(team.staff))
  const [savingFields, setSavingFields] = useState(false)
  const [savingRoster, setSavingRoster] = useState(false)
  const [fieldsError, setFieldsError] = useState('')
  const [rosterError, setRosterError] = useState('')
  const [rowErrors, setRowErrors] = useState({})
  const [svrzNames, setSvrzNames] = useState([])

  // VolleyManager team names of the competition's leagues, for the datalist
  const leagues = beach ? [] : (competition?.vm_leagues || [])
  useEffect(() => {
    if (!online || !leagues.length) return undefined
    let alive = true
    // Every game of these leagues (paged past the server's row cap)
    selectAll(() => apiFrom('svrz_games').select('id, team_home, team_away').in('league', leagues)).then(({ data }) => {
      if (!alive || !Array.isArray(data)) return
      const names = new Set()
      for (const g of data) {
        if (g.team_home) names.add(g.team_home)
        if (g.team_away) names.add(g.team_away)
      }
      setSvrzNames([...names].sort((a, b) => a.localeCompare(b)))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, leagues.join('|')])

  const setField = (k) => (e) => { setFields(f => ({ ...f, [k]: e.target.value })); setFieldsError('') }
  const fieldKeys = beach ? ['name', 'short_name', 'club', 'color'] : ['name', 'short_name', 'club', 'color', 'svrz_team_name']
  const fieldsDirty = fieldKeys.some(k => (fields[k] || '') !== (team[k] || ''))

  const saveFields = async () => {
    if (!fields.name.trim() || savingFields) return
    if (fields.color && !HEX.test(fields.color)) {
      setFieldsError(`${t('savedTeams.color')}: #rrggbb`)
      return
    }
    setSavingFields(true)
    const sent = {
      name: fields.name.trim(),
      short_name: fields.short_name.trim() || null,
      club: fields.club.trim() || null,
      color: fields.color ? fields.color.toLowerCase() : null
    }
    if (!beach) sent.svrz_team_name = fields.svrz_team_name.trim() || null
    const res = await savedTeamsApi.updateTeam(team.id, sent)
    setSavingFields(false)
    if (res.error) {
      setFieldsError(t(errorKeyOf(res.error)))
      return
    }
    // Only this section takes the saved values; unsaved players and
    // officials stay as they are (the editor is not remounted).
    setFields(f => ({ ...f, ...Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v ?? ''])) }))
    toast.success(t('manage.accounts.saved'))
    onChanged?.()
  }

  const updatePlayer = (key, patch) => {
    setPlayers(list => list.map(p => {
      if (p.key === key) return { ...p, ...patch }
      // One captain: ticking a captain clears the others
      if (patch.is_captain) return { ...p, is_captain: false }
      return p
    }))
    setRosterError('')
    setRowErrors({})
  }
  const updateStaff = (key, patch) => {
    setStaff(list => list.map(s => (s.key === key ? { ...s, ...patch } : s)))
    setRosterError('')
    setRowErrors({})
  }

  const updateSlot = (number, patch) => {
    setSlots(list => list.map(p => (p.number === number ? { ...p, ...patch } : p)))
    setRosterError('')
    setRowErrors({})
  }
  const updateCoach = (patch) => {
    setCoach(c => ({ ...(c || emptyCoach()), ...patch }))
    setRosterError('')
    setRowErrors({})
  }

  const saveRoster = async () => {
    if (savingRoster) return
    const body = beach ? draftToBeachRosterBody(slots, coach) : draftToRosterBody(players, staff)
    const problems = validateSavedRoster(body, { sport: beach ? 'beach' : 'indoor' })
    if (problems.length) {
      const map = {}
      for (const pr of problems) {
        if (pr.index === null) continue
        // beach: errors point at the slot (by number) and the coach, not the body index
        const key = !beach ? `${pr.list}:${pr.index}` : pr.list === 'players' ? `slot:${body.players[pr.index]?.number}` : 'coach'
        map[key] = t(pr.key, pr.params)
      }
      setRowErrors(map)
      setRosterError(t(problems[0].key, problems[0].params))
      return
    }
    setSavingRoster(true)
    const res = await savedTeamsApi.putRoster(team.id, body)
    setSavingRoster(false)
    if (res.error) {
      setRosterError(res.error.code === 'OV_INVALID_REQUEST' && res.error.details ? `${t('manage.errors.generic')} (${res.error.details})` : t(errorKeyOf(res.error)))
      return
    }
    toast.success(t('savedTeams.rosterSaved'))
    const saved = res.data?.team
    if (saved) {
      setPlayers((saved.players || []).map(toPlayerDraft))
      setStaff((saved.staff || []).map(toStaffDraft))
      setSlots(beachSlotsFromPlayers(saved.players))
      setCoach(toCoachDraft(saved.staff))
    }
    onChanged?.()
  }

  const deleteTeam = async () => {
    const ok = await confirmDialog({
      title: t('savedTeams.deleteTeamConfirmTitle', { name: team.name }),
      message: t('savedTeams.deleteTeamConfirmBody'),
      confirmLabel: t('savedTeams.deleteTeam'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await savedTeamsApi.deleteTeam(team.id)
    if (res.error) {
      setFieldsError(t(errorKeyOf(res.error)))
      return
    }
    onDeleted?.()
  }

  const listId = useMemo(() => `svrz-names-${team.id}`, [team.id])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>{competition?.name || t('savedTeams.teams')}</Button>
      </div>

      {/* Team fields */}
      <section className="rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('savedTeams.teamName')}>
            <Input value={fields.name} onChange={setField('name')} maxLength={120} required />
          </Field>
          <Field label={t('savedTeams.shortName')}>
            <Input value={fields.short_name} onChange={setField('short_name')} maxLength={20} />
          </Field>
          <Field label={t('savedTeams.club')}>
            <Input value={fields.club} onChange={setField('club')} maxLength={120} />
          </Field>
          <Field label={t('savedTeams.color')}>
            <div className="flex gap-2">
              <input
                type="color"
                value={HEX.test(fields.color) ? fields.color : '#e2001a'}
                onChange={e => { setFields(f => ({ ...f, color: e.target.value })); setFieldsError('') }}
                aria-label={t('savedTeams.color')}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-stone-300 bg-white p-1"
              />
              <Input value={fields.color} onChange={setField('color')} maxLength={7} placeholder="#rrggbb" className="font-mono" aria-label={`${t('savedTeams.color')} (hex)`} />
            </div>
          </Field>
          {/* Field takes exactly one control (Children.only): the datalist sits beside it */}
          {!beach && (
            <div className="min-w-0 sm:col-span-2">
              <Field label={t('savedTeams.svrzTeamName')} hint={t('savedTeams.svrzTeamNameHint')}>
                <Input value={fields.svrz_team_name} onChange={setField('svrz_team_name')} maxLength={120} list={listId} />
              </Field>
              <datalist id={listId}>{svrzNames.map(n => <option key={n} value={n} />)}</datalist>
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="positive" onClick={saveFields} loading={savingFields} disabled={!online || !fieldsDirty || !fields.name.trim() || savingFields}>{t('manage.accounts.save')}</Button>
          <InlineError error={fieldsError} />
          <Button variant="danger-outline" icon={Trash2} className="ml-auto" onClick={deleteTeam} disabled={!online}>{t('savedTeams.deleteTeam')}</Button>
        </div>
      </section>

      {beach && (
        <BeachRoster
          slots={slots}
          coach={coach}
          rowErrors={rowErrors}
          onSlot={updateSlot}
          onClearSlot={(number) => updateSlot(number, { first_name: '', last_name: '', dob: '', license_number: '', country: '' })}
          onCoach={updateCoach}
          onAddCoach={() => setCoach(emptyCoach())}
          onRemoveCoach={() => { setCoach(null); setRosterError(''); setRowErrors({}) }}
        />
      )}

      {/* Players */}
      {!beach && (
        <section>
          <SectionHeader title={t('savedTeams.players')} count={players.length} action={
            <Button variant="ghost" size="sm" icon={Plus} disabled={players.length >= MAX_PLAYERS} onClick={() => setPlayers(list => [...list, toPlayerDraft(null)])}>{t('savedTeams.addPlayer')}</Button>
          } />
          {players.length === 0 ? (
            <EmptyInset>{t('savedTeams.emptyRoster')}</EmptyInset>
          ) : (
            <div>
              <div className={cn(HEAD, 'grid-cols-[4rem_1fr_1fr_9.5rem_8rem_auto] gap-2 px-1 pb-1')}>
                <span>{t('savedTeams.number')}</span>
                <span>{t('savedTeams.firstName')}</span>
                <span>{t('savedTeams.lastName')}</span>
                <span>{t('savedTeams.dob')}</span>
                <span>{t('savedTeams.license')}</span>
                <span />
              </div>
              <div className="divide-y divide-stone-100">
                {players.map((p, i) => (
                  <div key={p.key} className={cn('py-2', !p.active && 'opacity-60')} data-testid="player-row">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[4rem_1fr_1fr_9.5rem_8rem_auto] sm:items-center">
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.number')}</span>
                        <Input type="number" inputMode="numeric" numeric min={0} max={99} value={p.number} onChange={e => updatePlayer(p.key, { number: e.target.value })} aria-label={t('savedTeams.number')} className="tabular-nums" />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.firstName')}</span>
                        <Input value={p.first_name} onChange={e => updatePlayer(p.key, { first_name: e.target.value })} aria-label={t('savedTeams.firstName')} />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.lastName')}</span>
                        <Input value={p.last_name} onChange={e => updatePlayer(p.key, { last_name: e.target.value })} aria-label={t('savedTeams.lastName')} invalid={!!rowErrors[`players:${i}`]} required />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.dob')}</span>
                        <DateField value={p.dob} onChange={v => updatePlayer(p.key, { dob: v })} aria-label={t('savedTeams.dob')} />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.license')}</span>
                        <Input value={p.license_number} onChange={e => updatePlayer(p.key, { license_number: e.target.value })} aria-label={t('savedTeams.license')} maxLength={40} />
                      </label>
                      <div className="flex items-center justify-end">
                        <IconButton icon={X} label={`${t('common.delete', 'Delete')} ${p.last_name || ''}`.trim()} onClick={() => setPlayers(list => list.filter(x => x.key !== p.key))} />
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Checkbox variant="dense" label={t('savedTeams.libero')} checked={p.is_libero} onChange={e => updatePlayer(p.key, { is_libero: e.target.checked })} />
                      <Checkbox variant="dense" label={t('savedTeams.captain')} checked={p.is_captain} onChange={e => updatePlayer(p.key, { is_captain: e.target.checked })} />
                      <span className="inline-flex items-center gap-2 text-sm text-stone-700">
                        <Switch checked={p.active} onCheckedChange={(v) => updatePlayer(p.key, { active: v, ...(v ? {} : { is_captain: false }) })} aria-label={t('savedTeams.active')} />
                        {t('savedTeams.active')}
                      </span>
                      <InlineError error={rowErrors[`players:${i}`]} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Team officials */}
      {!beach && (
        <section>
          <SectionHeader title={t('savedTeams.staff')} count={staff.length} action={
            <Button variant="ghost" size="sm" icon={Plus} disabled={staff.length >= MAX_STAFF} onClick={() => setStaff(list => [...list, toStaffDraft(null)])}>{t('savedTeams.addStaff')}</Button>
          } />
          {staff.length > 0 && (
            <div>
              <div className={cn(HEAD, 'grid-cols-[11rem_1fr_1fr_9.5rem_8rem_auto] gap-2 px-1 pb-1')}>
                <span>{t('savedTeams.role')}</span>
                <span>{t('savedTeams.firstName')}</span>
                <span>{t('savedTeams.lastName')}</span>
                <span>{t('savedTeams.dob')}</span>
                <span>{t('savedTeams.license')}</span>
                <span />
              </div>
              <div className="divide-y divide-stone-100">
                {staff.map((s, i) => (
                  <div key={s.key} className="py-2" data-testid="staff-row">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr_1fr_9.5rem_8rem_auto] sm:items-center">
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.role')}</span>
                        <Select value={s.role} onChange={e => updateStaff(s.key, { role: e.target.value })} aria-label={t('savedTeams.role')}>
                          {STAFF_ROLES.map(r => <option key={r} value={r}>{t(STAFF_ROLE_KEYS[r], r)}</option>)}
                        </Select>
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.firstName')}</span>
                        <Input value={s.first_name} onChange={e => updateStaff(s.key, { first_name: e.target.value })} aria-label={t('savedTeams.firstName')} />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.lastName')}</span>
                        <Input value={s.last_name} onChange={e => updateStaff(s.key, { last_name: e.target.value })} aria-label={t('savedTeams.lastName')} invalid={!!rowErrors[`staff:${i}`]} required />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.dob')}</span>
                        <DateField value={s.dob} onChange={v => updateStaff(s.key, { dob: v })} aria-label={t('savedTeams.dob')} />
                      </label>
                      <label className="block">
                        <span className={CELL_LABEL}>{t('savedTeams.license')}</span>
                        <Input value={s.license_number} onChange={e => updateStaff(s.key, { license_number: e.target.value })} aria-label={t('savedTeams.license')} maxLength={40} />
                      </label>
                      <div className="flex items-center justify-end">
                        <IconButton icon={X} label={`${t('common.delete', 'Delete')} ${s.last_name || ''}`.trim()} onClick={() => setStaff(list => list.filter(x => x.key !== s.key))} />
                      </div>
                    </div>
                    <InlineError error={rowErrors[`staff:${i}`]} className="mt-1" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="positive" onClick={saveRoster} loading={savingRoster} disabled={!online || savingRoster} data-testid="save-roster">{t('savedTeams.saveRoster')}</Button>
        <InlineError error={rosterError} />
      </div>
    </div>
  )
}

/**
 * The beach pair: two fixed slots (player 1 and player 2, no libero, captain
 * or active flags; the captain is chosen per match in OpenBeach) and at most
 * one coach. One input per row on phones, the indoor row grid from sm on.
 */
function BeachRoster({ slots, coach, rowErrors, onSlot, onClearSlot, onCoach, onAddCoach, onRemoveCoach }) {
  const { t } = useTranslation()
  return (
    <>
      <section>
        <SectionHeader title={t('savedTeams.players')} count={slots.filter(p => p.first_name.trim() || p.last_name.trim()).length} />
        <p className="mb-1 mt-2 text-sm text-stone-500">{t('savedTeams.beachTeamHint')}</p>
        <div className="divide-y divide-stone-100">
          {slots.map(p => {
            const error = rowErrors[`slot:${p.number}`]
            const hintId = `beach-country-hint-${p.number}`
            return (
              <div key={p.number} className="py-2" data-testid="beach-slot">
                <p className="mb-1 text-[13px] font-semibold text-stone-800">{t('savedTeams.beachPlayer', { number: p.number })}</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_9.5rem_8rem_5rem_auto] sm:items-center">
                  <label className="block">
                    <span className={CELL_LABEL}>{t('savedTeams.firstName')}</span>
                    <Input value={p.first_name} onChange={e => onSlot(p.number, { first_name: e.target.value })} aria-label={`${t('savedTeams.firstName')} ${p.number}`} maxLength={80} />
                  </label>
                  <label className="block">
                    <span className={CELL_LABEL}>{t('savedTeams.lastName')}</span>
                    <Input value={p.last_name} onChange={e => onSlot(p.number, { last_name: e.target.value })} aria-label={`${t('savedTeams.lastName')} ${p.number}`} maxLength={80} invalid={!!error} />
                  </label>
                  <label className="block">
                    <span className={CELL_LABEL}>{t('savedTeams.dob')}</span>
                    <DateField value={p.dob} onChange={v => onSlot(p.number, { dob: v })} aria-label={`${t('savedTeams.dob')} ${p.number}`} />
                  </label>
                  <label className="block">
                    <span className={CELL_LABEL}>{t('savedTeams.license')}</span>
                    <Input value={p.license_number} onChange={e => onSlot(p.number, { license_number: e.target.value })} aria-label={`${t('savedTeams.license')} ${p.number}`} maxLength={40} />
                  </label>
                  <label className="block">
                    <span className={CELL_LABEL}>{t('savedTeams.country')}</span>
                    <Input
                      value={p.country}
                      onChange={e => onSlot(p.number, { country: e.target.value.toUpperCase() })}
                      aria-label={`${t('savedTeams.country')} ${p.number}`}
                      aria-describedby={hintId}
                      title={t('savedTeams.countryHint')}
                      placeholder="CHE"
                      maxLength={3}
                      className="font-mono uppercase"
                    />
                  </label>
                  <div className="flex items-center justify-end">
                    <IconButton icon={X} label={t('savedTeams.clearPlayer', { number: p.number })} onClick={() => onClearSlot(p.number)} />
                  </div>
                </div>
                <p id={hintId} className="mt-1 text-[11px] text-stone-400">{t('savedTeams.countryHint')}</p>
                <InlineError error={error} className="mt-1" />
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <SectionHeader title={t('savedTeams.coach')} action={!coach && (
          <Button variant="ghost" size="sm" icon={Plus} onClick={onAddCoach}>{t('savedTeams.addCoach')}</Button>
        )} />
        {coach && (
          <div className="py-2" data-testid="beach-coach">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_9.5rem_8rem_auto] sm:items-center">
              <label className="block">
                <span className={CELL_LABEL}>{t('savedTeams.firstName')}</span>
                <Input value={coach.first_name} onChange={e => onCoach({ first_name: e.target.value })} aria-label={`${t('savedTeams.coach')}: ${t('savedTeams.firstName')}`} maxLength={80} />
              </label>
              <label className="block">
                <span className={CELL_LABEL}>{t('savedTeams.lastName')}</span>
                <Input value={coach.last_name} onChange={e => onCoach({ last_name: e.target.value })} aria-label={`${t('savedTeams.coach')}: ${t('savedTeams.lastName')}`} maxLength={80} invalid={!!rowErrors.coach} />
              </label>
              <label className="block">
                <span className={CELL_LABEL}>{t('savedTeams.dob')}</span>
                <DateField value={coach.dob} onChange={v => onCoach({ dob: v })} aria-label={`${t('savedTeams.coach')}: ${t('savedTeams.dob')}`} />
              </label>
              <label className="block">
                <span className={CELL_LABEL}>{t('savedTeams.license')}</span>
                <Input value={coach.license_number} onChange={e => onCoach({ license_number: e.target.value })} aria-label={`${t('savedTeams.coach')}: ${t('savedTeams.license')}`} maxLength={40} />
              </label>
              <div className="flex items-center justify-end">
                <IconButton icon={X} label={t('savedTeams.removeCoach')} onClick={onRemoveCoach} />
              </div>
            </div>
            <InlineError error={rowErrors.coach} className="mt-1" />
          </div>
        )}
      </section>
    </>
  )
}
