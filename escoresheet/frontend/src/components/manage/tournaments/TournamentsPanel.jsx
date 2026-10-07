import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import KitModal from '../KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError } from '../common'
import { tournamentApi, tournamentErrorKey } from '../../../lib/tournamentApi'
import { useAuth } from '../../../contexts/AuthContext'
import { accessForApp } from '../../../lib/access'
import { Button, Field, Input, RowList, Row, Chip, EmptyInset, SkeletonRows, Notice, toast } from '../../../ui'
import TournamentView from './TournamentView'
import { TournamentStatus, datesLabel } from './shared'

function NewTournamentModal({ open, onClose, onCreated }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ title: '', starts_on: '', ends_on: '', venue: '', city: '', courts: '2' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setError('') }
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
      courts: Math.max(0, Math.min(40, Number(form.courts) || 0))
    })
    setBusy(false)
    if (res.error) return setError(t(tournamentErrorKey(res.error)))
    toast.success(t('tournaments.created'))
    onCreated(res.data.tournament)
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
        <Field label={t('tournaments.name')}>
          <Input value={form.title} onChange={set('title')} maxLength={160} required autoFocus data-testid="tournament-title" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.startsOn')}>
            <Input type="date" value={form.starts_on} onChange={set('starts_on')} required data-testid="tournament-starts" />
          </Field>
          <Field label={t('tournaments.endsOn')}>
            <Input type="date" value={form.ends_on} min={form.starts_on || undefined} onChange={set('ends_on')} />
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
 * OpenBeach tournaments (manager-beach, plan phase T1): the list, a new
 * tournament, and the tournament itself (TournamentView). Beach competition
 * managers and the global admin; the server enforces it.
 */
export default function TournamentsPanel() {
  const { t } = useTranslation()
  const online = useOnline()
  const { access } = useAuth()
  const canCreate = accessForApp(access, 'beach').canManageTeams
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const { data, error, loading, reload } = usePanelData(() => tournamentApi.list(), [], { enabled: online })
  const list = data?.tournaments || []

  if (openId) {
    return <TournamentView id={openId} onBack={() => { setOpenId(null); reload() }} />
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
        onCreated={(tour) => { setCreating(false); reload(); setOpenId(tour.id) }}
      />
    </section>
  )
}
