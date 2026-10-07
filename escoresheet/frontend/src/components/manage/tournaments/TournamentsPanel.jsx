import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import KitModal from '../KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError } from '../common'
import { tournamentApi, tournamentErrorKey } from '../../../lib/tournamentApi'
import { useAuth } from '../../../contexts/AuthContext'
import { accessForApp } from '../../../lib/access'
import { Button, DateField, Field, Input, RowList, Row, Chip, EmptyInset, SkeletonRows, Notice, SegmentedControl, toast } from '../../../ui'
import TournamentView from './TournamentView'
import { TournamentStatus, datesLabel } from './shared'

function NewTournamentModal({ open, onClose, onCreated }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ title: '', starts_on: '', ends_on: '', venue: '', city: '', courts: '2' })
  // plan 3.3: typed into the manager, or from an Excel/CSV file (the import opens next); Swiss Volley: T5
  const [source, setSource] = useState('manual')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Inputs hand over an event, the date fields their ISO value.
  const set = (k) => (e) => { const v = e?.target ? e.target.value : e; setForm(f => ({ ...f, [k]: v })); setError('') }
  const valid = form.title.trim() && form.starts_on && (!form.ends_on || form.ends_on >= form.starts_on)
  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const res = await tournamentApi.create({
      title: form.title.trim(),
      starts_on: form.starts_on,
      ends_on: form.ends_on || form.starts_on,
      venue: form.venue.trim() || null,
      city: form.city.trim() || null,
      courts: Math.max(0, Math.min(40, Number(form.courts) || 0)),
      ...(source === 'xlsx' ? { source } : {})
    })
    setBusy(false)
    if (res.error) return setError(t(tournamentErrorKey(res.error)))
    toast.success(t('tournaments.created'))
    onCreated(res.data.tournament, { importNext: source === 'xlsx' })
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={t('tournaments.new')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="dark" size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="tournament-create">{t('tournaments.create')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-stone-700">{t('tournaments.startWith')}</legend>
          <SegmentedControl
            ariaLabel={t('tournaments.startWith')}
            value={source}
            onChange={setSource}
            options={[{ value: 'manual', label: t('tournaments.startManual') }, { value: 'xlsx', label: t('tournaments.startFile') }]}
          />
          {source === 'xlsx' && <p className="mt-1.5 text-xs text-stone-500">{t('tournaments.startFileHint')}</p>}
        </fieldset>
        <Field label={t('tournaments.name')}>
          <Input value={form.title} onChange={set('title')} maxLength={160} required autoFocus data-testid="tournament-title" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.startsOn')}>
            <DateField value={form.starts_on} onChange={set('starts_on')} required data-testid="tournament-starts" />
          </Field>
          <Field label={t('tournaments.endsOn')}>
            <DateField value={form.ends_on} min={form.starts_on || undefined} onChange={set('ends_on')} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.venue')}>
            <Input value={form.venue} onChange={set('venue')} maxLength={160} />
          </Field>
          <Field label={t('tournaments.city')}>
            <Input value={form.city} onChange={set('city')} maxLength={120} />
          </Field>
        </div>
        <Field label={t('tournaments.courtsCount')}>
          <Input type="number" inputMode="numeric" min={0} max={40} value={form.courts} onChange={set('courts')} className="w-24" />
        </Field>
        <InlineError error={error} />
      </form>
    </KitModal>
  )
}

/**
 * OpenBeach tournaments (manager-beach, plan phases T1 and T2): the list, a
 * new tournament (typed in, or from an Excel/CSV file), and the tournament
 * itself (TournamentView). Beach competition
 * managers and the global admin; the server enforces it.
 */
export default function TournamentsPanel() {
  const { t } = useTranslation()
  const online = useOnline()
  const { access } = useAuth()
  const canCreate = accessForApp(access, 'beach').canManageTeams
  const [openId, setOpenId] = useState(null)
  const [importNext, setImportNext] = useState(false)
  const [creating, setCreating] = useState(false)
  const { data, error, loading, reload } = usePanelData(() => tournamentApi.list(), [], { enabled: online })
  const list = data?.tournaments || []

  if (openId) {
    return <TournamentView id={openId} initialImport={importNext} onBack={() => { setOpenId(null); setImportNext(false); reload() }} />
  }

  return (
    <section>
      <PanelHead title={t('tournaments.title')}>
        {canCreate && (
          <Button icon={Plus} onClick={() => setCreating(true)} disabled={!online} data-testid="tournament-new">{t('tournaments.new')}</Button>
        )}
      </PanelHead>
      <OfflineBanner online={online} />
      {error && <Notice tone="error" className="mb-3">{t(tournamentErrorKey(error))}</Notice>}
      {loading && !data ? <SkeletonRows rows={4} /> : list.length === 0 ? (
        <EmptyInset>{t('tournaments.empty')}</EmptyInset>
      ) : (
        <RowList>
          {list.map(x => (
            <Row
              key={x.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={x.title}
              meta={<>
                <span className="tabular-nums">{datesLabel(x.starts_on, x.ends_on)}</span>
                {(x.venue || x.city) && <span>{[x.venue, x.city].filter(Boolean).join(', ')}</span>}
              </>}
              chips={<>
                <Chip>{t('tournaments.drawsCount', { count: x.draws })}</Chip>
                {x.public && <Chip tone="sky">{t('tournaments.publicChip')}</Chip>}
                {!x.can_edit && <Chip>{t('tournaments.readOnly')}</Chip>}
              </>}
              status={<TournamentStatus status={x.status} />}
              onOpen={() => setOpenId(x.id)}
              label={x.title}
            />
          ))}
        </RowList>
      )}
      <NewTournamentModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(tour, { importNext: next = false } = {}) => { setCreating(false); reload(); setImportNext(next); setOpenId(tour.id) }}
      />
    </section>
  )
}
