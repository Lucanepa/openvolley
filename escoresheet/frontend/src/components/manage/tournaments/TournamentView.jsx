import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Plus, Trash2, UserPlus } from 'lucide-react'
import { usePanelData, useOnline, OfflineBanner, InlineError } from '../common'
import { tournamentApi } from '../../../lib/tournamentApi'
import { askConfirm } from '../../../utils/askConfirm'
import { askText } from '../../../utils/askText'
import {
  Button, Card, CardHeading, Field, Input, Select, Switch, SegmentedControl, RowList, SimpleRow, Chip,
  EmptyInset, SkeletonRows, Notice, IconButton, toast
} from '../../../ui'
import { TournamentStatus, datesLabel, useTournamentError } from './shared'
import DrawsSection from './DrawsSection'
import ScheduleSection from './ScheduleSection'
import RankingSection from './RankingSection'
import ImportModal from './ImportModal'

const STATUSES = ['draft', 'published', 'live', 'finished', 'archived']

function DetailsSection({ bundle, reload, onDeleted }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const tour = bundle.tournament
  const edit = tour.can_edit
  const initial = () => ({
    title: tour.title, slug: tour.slug, venue: tour.venue || '', city: tour.city || '', starts_on: tour.starts_on,
    ends_on: tour.ends_on, day_start: tour.day_start, day_end: tour.day_end, status: tour.status
  })
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // a reload (another section saved) shows the stored values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(initial()) }, [tour.updated_at])
  const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setError('') }

  const save = async (e) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    const res = await tournamentApi.update(tour.id, { ...form, venue: form.venue.trim() || null, city: form.city.trim() || null })
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    toast.success(t('tournaments.saved'))
    reload()
  }
  const setPublic = async (next) => {
    const res = await tournamentApi.update(tour.id, { public: next })
    if (res.error) return toast.error(errorText(res.error))
    reload()
  }
  const addManager = async () => {
    const email = await askText({ title: t('tournaments.addManager'), label: t('tournaments.managerEmail'), type: 'email', confirmLabel: t('tournaments.add') })
    if (!email) return
    const res = await tournamentApi.addManager(tour.id, email.trim())
    if (res.error) return toast.error(res.error.code === 'OV_NOT_FOUND' ? t('tournaments.errors.noManager') : errorText(res.error))
    toast.success(t('tournaments.managerAdded'))
    reload()
  }
  const removeManager = async (m) => {
    if (!(await askConfirm({ title: t('tournaments.removeManagerTitle', { name: m.name || m.email }), confirmLabel: t('tournaments.remove'), tone: 'danger' }))) return
    const res = await tournamentApi.removeManager(tour.id, m.id)
    if (res.error) return toast.error(errorText(res.error))
    reload()
  }
  const remove = async () => {
    if (!(await askConfirm({
      title: t('tournaments.deleteTitle', { title: tour.title }),
      message: t('tournaments.deleteBody'),
      confirmLabel: t('tournaments.delete'),
      tone: 'danger'
    }))) return
    const res = await tournamentApi.remove(tour.id)
    if (res.error) return toast.error(errorText(res.error))
    toast.success(t('tournaments.deleted'))
    onDeleted()
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeading title={t('tournaments.sections.details')} />
        <form onSubmit={save} className="space-y-3">
          <Field label={t('tournaments.name')}>
            <Input value={form.title} onChange={set('title')} maxLength={160} required disabled={!edit} />
          </Field>
          <Field label={t('tournaments.slug')} hint={t('tournaments.slugHint')}>
            <Input value={form.slug} onChange={set('slug')} maxLength={80} disabled={!edit} className="font-mono" />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('tournaments.venue')}><Input value={form.venue} onChange={set('venue')} maxLength={160} disabled={!edit} /></Field>
            <Field label={t('tournaments.city')}><Input value={form.city} onChange={set('city')} maxLength={120} disabled={!edit} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label={t('tournaments.startsOn')}><Input type="date" value={form.starts_on} onChange={set('starts_on')} required disabled={!edit} /></Field>
            <Field label={t('tournaments.endsOn')}><Input type="date" value={form.ends_on} onChange={set('ends_on')} required disabled={!edit} /></Field>
            <Field label={t('tournaments.dayStart')}><Input type="time" value={form.day_start} onChange={set('day_start')} required disabled={!edit} /></Field>
            <Field label={t('tournaments.dayEnd')}><Input type="time" value={form.day_end} onChange={set('day_end')} required disabled={!edit} /></Field>
          </div>
          <Field label={t('tournaments.status')}>
            <Select value={form.status} onChange={set('status')} disabled={!edit}
              options={STATUSES.map(s => ({ value: s, label: t(`tournaments.statuses.${s}`) }))} />
          </Field>
          <InlineError error={error} />
          {edit && <Button type="submit" variant="dark" loading={busy} disabled={busy}>{t('tournaments.save')}</Button>}
        </form>
      </Card>

      <Card>
        <CardHeading
          title={t('tournaments.publicPage')}
          actions={<Switch checked={tour.public} onCheckedChange={setPublic} disabled={!edit} aria-label={t('tournaments.publicPage')} />}
        />
        <p className="mt-1 text-xs text-stone-500">{t('tournaments.publicHint')}</p>
      </Card>

      {edit && (
        <Card>
          <CardHeading
            title={t('tournaments.managers')}
            actions={<Button variant="ghost" size="sm" icon={UserPlus} onClick={addManager}>{t('tournaments.addManager')}</Button>}
          />
          <RowList className="mt-2">
            {bundle.managers.map(m => (
              <SimpleRow
                key={m.id}
                title={m.name || m.email}
                titleExtra={m.creator ? <Chip>{t('tournaments.creator')}</Chip> : null}
                meta={m.name ? m.email : null}
                trailing={!m.creator && (
                  <IconButton label={t('tournaments.remove')} icon={Trash2} variant="subtle" onClick={() => removeManager(m)} />
                )}
              />
            ))}
          </RowList>
        </Card>
      )}

      {edit && (
        <div className="flex justify-end">
          <Button variant="danger-outline" size="sm" icon={Trash2} onClick={remove}>{t('tournaments.delete')}</Button>
        </div>
      )}
    </div>
  )
}

function CourtsSection({ bundle, reload }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const edit = bundle.tournament.can_edit
  const toRows = () => bundle.courts.map(c => ({ number: c.number, name: c.name || '', active: c.active, flex: c.flex }))
  const [rows, setRows] = useState(toRows)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(toRows()) }, [bundle.courts])
  const change = (i, patch) => { setRows(r => r.map((x, j) => (j === i ? { ...x, ...patch } : x))); setError('') }
  const add = () => setRows(r => [...r, { number: Math.max(0, ...r.map(x => x.number)) + 1, name: '', active: true, flex: false }])
  const save = async () => {
    setBusy(true)
    const res = await tournamentApi.putCourts(bundle.tournament.id, rows.map(r => ({ ...r, name: r.name.trim() || null })))
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    toast.success(t('tournaments.saved'))
    reload()
  }
  return (
    <Card>
      <CardHeading title={t('tournaments.sections.courts')} hint={t('tournaments.flexHint')} />
      {rows.length === 0 ? <EmptyInset>{t('tournaments.noCourts')}</EmptyInset> : (
        <RowList>
          {rows.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 py-2">
              <span className="w-20 text-sm font-semibold tabular-nums text-stone-800">{t('tournaments.courtN', { n: c.number })}</span>
              <Input value={c.name} onChange={e => change(i, { name: e.target.value })} placeholder={t('tournaments.courtName')}
                aria-label={t('tournaments.courtName')} maxLength={60} disabled={!edit} className="w-40" />
              <label className="flex items-center gap-1.5 text-xs text-stone-600">
                <Switch checked={c.active} onCheckedChange={v => change(i, { active: v })} disabled={!edit} aria-label={t('tournaments.courtActive')} />
                {t('tournaments.courtActive')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-stone-600">
                <Switch checked={c.flex} onCheckedChange={v => change(i, { flex: v })} disabled={!edit} aria-label={t('tournaments.flex')} />
                {t('tournaments.flex')}
              </label>
              {edit && (
                <IconButton label={t('tournaments.removeCourt', { n: c.number })} icon={Trash2} variant="subtle" className="ml-auto"
                  onClick={() => setRows(r => r.filter((_, j) => j !== i))} />
              )}
            </div>
          ))}
        </RowList>
      )}
      <InlineError error={error} className="mt-2" />
      {edit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon={Plus} onClick={add} disabled={rows.length >= 40}>{t('tournaments.addCourt')}</Button>
          <Button variant="dark" size="sm" onClick={save} loading={busy} disabled={busy}>{t('tournaments.saveCourts')}</Button>
        </div>
      )}
    </Card>
  )
}

/**
 * One tournament: details and co-managers, courts, draws (entries, seeds,
 * bracket, results), the schedule, the final ranking, and the Excel/CSV
 * import (T2). Read-only for a tournament this account does not edit.
 */
export default function TournamentView({ id, onBack, initialImport = false }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useTournamentError()
  const [section, setSection] = useState('draws')
  // the Excel/CSV import (T2): from the Draws section, or right after "New tournament" from a file
  const [importing, setImporting] = useState(initialImport)
  const { data, error, loading, reload } = usePanelData(() => tournamentApi.get(id), [id], { enabled: online })

  const sections = ['details', 'courts', 'draws', 'schedule', ...(data?.tournament?.can_edit ? ['ranking'] : [])]
  return (
    <section>
      <div className="mb-2">
        <Button variant="text" icon={ArrowLeft} onClick={onBack}>{t('tournaments.allTournaments')}</Button>
      </div>
      {data && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-bold tracking-tight text-stone-900 sm:text-2xl">{data.tournament.title}</h1>
            <p className="mt-0.5 text-xs text-stone-500">
              <span className="tabular-nums">{datesLabel(data.tournament.starts_on, data.tournament.ends_on)}</span>
              {(data.tournament.venue || data.tournament.city) && <> · {[data.tournament.venue, data.tournament.city].filter(Boolean).join(', ')}</>}
            </p>
          </div>
          <TournamentStatus status={data.tournament.status} />
        </div>
      )}
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? <SkeletonRows rows={5} /> : data && (
        <>
          <div className="mb-4 overflow-x-auto">
            <SegmentedControl
              ariaLabel={t('tournaments.sectionsLabel')}
              value={section}
              onChange={setSection}
              options={sections.map(s => ({ value: s, label: t(`tournaments.sections.${s}`) }))}
            />
          </div>
          {section === 'details' && <DetailsSection bundle={data} reload={reload} onDeleted={onBack} />}
          {section === 'courts' && <CourtsSection bundle={data} reload={reload} />}
          {section === 'draws' && <DrawsSection bundle={data} reload={reload} onImport={online ? () => setImporting(true) : null} />}
          {section === 'schedule' && <ScheduleSection bundle={data} reload={reload} />}
          {section === 'ranking' && <RankingSection bundle={data} />}
          {data.tournament.can_edit && (
            <ImportModal
              open={importing}
              bundle={data}
              onClose={() => setImporting(false)}
              onApplied={() => { setImporting(false); setSection('draws'); reload() }}
            />
          )}
        </>
      )}
    </section>
  )
}
