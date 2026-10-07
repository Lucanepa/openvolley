import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'
import KitModal from '../KitModal'
import { InlineError, useKitLang } from '../common'
import { tournamentApi } from '../../../lib/tournamentApi'
import { askConfirm } from '../../../utils/askConfirm'
import { fromZurichInput, scheduleGrid, toZurichInput, zurichDay } from '../../../domain/beachTournament'
import { Button, Card, CardHeading, Field, Input, Select, EmptyInset, SectionHeader, Notice, toast, timeLabel, shortDayLabel } from '../../../ui'
import { useDrawName, useSideLabel, useTournamentError } from './shared'

const OPEN = ['scheduled', 'ready', 'called']

function MoveModal({ match, courts, onClose, onSaved }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const [courtId, setCourtId] = useState(match.court_id || '')
  const [at, setAt] = useState(toZurichInput(match.scheduled_at))
  const [referee, setReferee] = useState(match.referee || '')
  const [scorer, setScorer] = useState(match.scorer || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const movable = OPEN.includes(match.status)
  const submit = async (e) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const body = { referee: referee.trim() || null, scorer: scorer.trim() || null }
    if (movable) Object.assign(body, { court_id: courtId || null, scheduled_at: fromZurichInput(at) })
    let res = await tournamentApi.updateMatch(match.id, body)
    // the server checks the slot (court taken, play hours, rest after the
    // matches it waits for); the manager may still keep it on purpose
    if (res.error?.code === 'OV_SLOT_CONFLICT') {
      const conflicts = Array.isArray(res.error.details?.conflicts) ? res.error.details.conflicts : []
      setBusy(false)
      const keep = await askConfirm({
        title: t('tournaments.slotConflictTitle'),
        message: conflicts.map(c => t(`tournaments.slotConflicts.${c.reason}`, { n: c.game_n, code: c.code })).join('\n'),
        confirmLabel: t('tournaments.saveAnyway')
      })
      if (!keep) return
      setBusy(true)
      res = await tournamentApi.updateMatch(match.id, { ...body, force: true })
    }
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    toast.success(t('tournaments.saved'))
    onSaved()
  }
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={t('tournaments.moveTitle', { n: match.game_n, code: match.code })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="dark" size="lg" onClick={submit} loading={busy} disabled={busy}>{t('tournaments.save')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.court')}>
            <Select value={courtId} onChange={e => setCourtId(e.target.value)} block disabled={!movable}
              placeholder={t('tournaments.noCourt')}
              options={courts.map(c => ({ value: c.id, label: c.name ? `${c.number} · ${c.name}` : t('tournaments.courtN', { n: c.number }) }))} />
          </Field>
          <Field label={t('tournaments.startTime')}>
            <Input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} disabled={!movable} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.referee')}><Input value={referee} onChange={e => setReferee(e.target.value)} maxLength={120} /></Field>
          <Field label={t('tournaments.scorer')}><Input value={scorer} onChange={e => setScorer(e.target.value)} maxLength={120} /></Field>
        </div>
        {!movable && <Notice tone="warning">{t('tournaments.errors.matchBegun')}</Notice>}
        <InlineError error={error} />
      </form>
    </KitModal>
  )
}

/**
 * The schedule: generated over the active courts and the play hours
 * (lib/beachSchedule.js on the server), shown as a grid of start times x
 * courts per day, each match movable by hand.
 */
export default function ScheduleSection({ bundle, reload }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const errorText = useTournamentError()
  const drawName = useDrawName()
  const edit = bundle.tournament.can_edit
  const entriesById = useMemo(() => new Map(bundle.entries.map(e => [e.id, e])), [bundle.entries])
  const side = useSideLabel(entriesById)
  const drawsById = new Map(bundle.draws.map(d => [d.id, d]))
  const courts = bundle.courts.filter(c => c.active)
  const grid = scheduleGrid(bundle.matches, bundle.courts)
  const days = [...new Set(grid.times.map(zurichDay))]
  const [dayStart, setDayStart] = useState(bundle.tournament.day_start)
  const [dayEnd, setDayEnd] = useState(bundle.tournament.day_end)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moving, setMoving] = useState(null)

  const plan = async () => {
    setError('')
    setBusy(true)
    const dry = await tournamentApi.schedule(bundle.tournament.id, { dryRun: true, day_start: dayStart, day_end: dayEnd })
    setBusy(false)
    if (dry.error) return setError(errorText(dry.error))
    const warnings = (dry.data.warnings || []).map(w => t(`tournaments.warnings.${w.code}`, w))
    const message = [
      t('tournaments.scheduleBody', { placed: dry.data.slots.length }),
      ...(dry.data.unplaced.length ? [t('tournaments.unplaced', { count: dry.data.unplaced.length })] : []),
      ...warnings
    ].join('\n\n')
    if (!(await askConfirm({ title: t('tournaments.scheduleTitle'), message, confirmLabel: t('tournaments.applySchedule') }))) return
    setBusy(true)
    const res = await tournamentApi.schedule(bundle.tournament.id, { day_start: dayStart, day_end: dayEnd })
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    toast.success(t('tournaments.scheduleDone', { placed: res.data.slots.length }))
    reload()
  }

  const cell = (m) => {
    if (!m) return <span className="text-stone-300">–</span>
    const d = drawsById.get(m.draw_id)
    const ended = m.status === 'finished' || m.status === 'walkover'
    return (
      <button
        type="button"
        onClick={() => edit && setMoving(m)}
        disabled={!edit}
        className="w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-left transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:cursor-default"
        data-testid={`slot-${m.game_n}`}
      >
        <span className="block text-[11px] font-semibold tabular-nums text-stone-500">#{m.game_n} {m.code} · {d ? drawName(d) : ''}</span>
        <span className={`block text-xs ${ended ? 'text-stone-500' : 'text-stone-800'}`}>{side(m.entry1_id, m.source1)}</span>
        <span className={`block text-xs ${ended ? 'text-stone-500' : 'text-stone-800'}`}>{side(m.entry2_id, m.source2)}</span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      {edit && (
        <Card>
          <CardHeading title={t('tournaments.scheduleTitle')} hint={t('tournaments.scheduleHint')} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('tournaments.dayStart')}><Input type="time" value={dayStart} onChange={e => setDayStart(e.target.value)} /></Field>
            <Field label={t('tournaments.dayEnd')}><Input type="time" value={dayEnd} onChange={e => setDayEnd(e.target.value)} /></Field>
            <Button icon={CalendarClock} onClick={plan} loading={busy} disabled={busy || !courts.length || !bundle.matches.length} data-testid="schedule-plan">
              {t('tournaments.planSchedule')}
            </Button>
          </div>
          {!courts.length && <Notice tone="warning" className="mt-3">{t('tournaments.errors.noCourts')}</Notice>}
          <InlineError error={error} className="mt-2" />
        </Card>
      )}
      <Card>
        <CardHeading title={t('tournaments.sections.schedule')} />
        {grid.times.length === 0 ? <EmptyInset>{t('tournaments.noSchedule')}</EmptyInset> : days.map(day => {
          const times = grid.times.filter(x => zurichDay(x) === day)
          return (
            <div key={day} className="mb-4">
              <SectionHeader title={shortDayLabel(`${day}`, lang)} count={times.length} />
              <div className="overflow-x-auto">
                <table className="mt-2 w-full border-separate border-spacing-1 text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="w-14 font-semibold">{t('tournaments.time')}</th>
                      {grid.courts.map(c => <th key={c.id} className="min-w-[10rem] font-semibold">{c.name || t('tournaments.courtN', { n: c.number })}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {times.map(time => (
                      <tr key={time} className="align-top">
                        <td className="pt-1.5 text-xs font-semibold tabular-nums text-stone-700">{timeLabel(time)}</td>
                        {grid.courts.map(c => <td key={c.id}>{cell(grid.cell(time, c.id))}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
        {grid.unscheduled.length > 0 && (
          <div>
            <SectionHeader title={t('tournaments.notPlanned')} count={grid.unscheduled.length} />
            <div className="mt-2 grid gap-1 sm:grid-cols-3">{grid.unscheduled.map(m => <div key={m.id}>{cell(m)}</div>)}</div>
          </div>
        )}
      </Card>
      {moving && <MoveModal match={moving} courts={courts} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); reload() }} />}
    </div>
  )
}
