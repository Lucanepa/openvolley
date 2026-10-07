import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Plus } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, DateField, Field, Input, Select, RowList, Row, RowTool, Chip, StatusPill, EmptyInset, SkeletonRows, Notice, ModalStrip, dayLabel, confirmDialog, toast } from '../../ui'

const STATE_TONE = { active: 'done', expired: 'neutral', used_up: 'neutral', revoked: 'brand' }
const INVITE_ROLES = ['scorer', 'referee', 'competition_manager']

function plusDays(days) {
  const d = new Date(Date.now() + days * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Invite codes: create (shown once), list, revoke (admins). `app` 'indoor' /
 * 'beach' (OpenVolley's / OpenBeach's console): that app's codes only, and
 * new codes are of that sport (beach: they grant the beach role). Left out:
 * every code, new codes indoor (as before).
 */
export default function InvitesPanel({ app }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null) // { code, invite } — shown once
  const [rowError, setRowError] = useState({})
  const { data, error, loading, reload } = usePanelData(() => (app ? admin.listInvites({ app }) : admin.listInvites()), [app], { enabled: online })
  const invites = data?.invites || []

  const revoke = async (invite) => {
    const ok = await confirmDialog({
      title: t('manage.invites.revokeConfirmTitle'),
      message: t('manage.invites.revokeConfirmBody'),
      confirmLabel: t('manage.invites.revoke'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await admin.revokeInvite(invite.id)
    if (res.error) {
      setRowError(e => ({ ...e, [invite.id]: errorText(res.error) }))
      return
    }
    reload()
  }

  return (
    <section>
      <PanelHead title={t('manage.tabs.invites')}>
        <Button icon={Plus} onClick={() => setCreating(true)} disabled={!online}>{t('manage.invites.new')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={4} pill={false} />
      ) : invites.length === 0 ? (
        <EmptyInset>{t('manage.invites.empty')}</EmptyInset>
      ) : (
        <RowList>
          {invites.map(inv => (
            <Row
              key={inv.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={inv.label}
              status={<StatusPill tone={STATE_TONE[inv.state] || 'neutral'}>{t(`manage.invites.state.${inv.state}`, inv.state)}</StatusPill>}
              meta={<>
                <span className="font-mono tabular-nums">…{inv.code_hint}</span>
                <span className="tabular-nums">{inv.max_uses ? t('manage.invites.uses', { uses: inv.uses, max: inv.max_uses }) : t('manage.invites.usesUnlimited', { uses: inv.uses })}</span>
                {inv.expires_at && <span>{t('manage.invites.expires')} {dayLabel(inv.expires_at, { year: true })}</span>}
                {inv.created_by_name && <span>{inv.created_by_name}</span>}
              </>}
              chips={<>
                {inv.club && <Chip>{inv.club}</Chip>}
                <Chip tone="indigo">{t(`access.roles.${inv.role}`, inv.role)}</Chip>
              </>}
              tools={inv.state === 'active' || rowError[inv.id] ? <>
                {inv.state === 'active' && <RowTool disabled={!online} onClick={() => revoke(inv)}>{t('manage.invites.revoke')}</RowTool>}
                <InlineError error={rowError[inv.id]} className="ml-1" />
              </> : null}
            />
          ))}
        </RowList>
      )}
      <CreateInviteModal
        app={app}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(res) => { setCreating(false); setCreated(res); reload() }}
      />
      <KitModal
        open={!!created}
        onClose={() => setCreated(null)}
        decision
        dismissible={false}
        layout="sections"
        title={t('manage.invites.createdTitle')}
        closeLabel={t('common.close', 'Close')}
        footer={<Button variant="dark" size="lg" onClick={() => setCreated(null)}>{t('common.close', 'Close')}</Button>}
      >
        <ModalStrip>{t('manage.invites.createdOnce')}</ModalStrip>
        <div className="flex flex-col items-stretch gap-2 min-[420px]:flex-row min-[420px]:items-center">
          <output data-testid="invite-code" className="flex-1 select-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-center font-mono text-lg font-bold tracking-[0.3em] text-stone-900">
            {created?.code}
          </output>
          <Button
            variant="secondary"
            icon={Copy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created?.code || '')
                toast.success(t('manage.invites.copied'))
              } catch { /* no clipboard: the code stays selectable */ }
            }}
          >
            {t('manage.invites.copy')}
          </Button>
        </div>
        <p className="text-xs text-stone-500">{created?.invite?.label}{created?.invite?.club ? ` · ${created.invite.club}` : ''} · {t(`access.roles.${created?.invite?.role || 'scorer'}`)}</p>
      </KitModal>
    </section>
  )
}

function CreateInviteModal({ app, open, onClose, onCreated }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [label, setLabel] = useState('')
  const [club, setClub] = useState('')
  const [role, setRole] = useState('scorer')
  const [maxUses, setMaxUses] = useState('1')
  const [expires, setExpires] = useState(plusDays(30))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => { setLabel(''); setClub(''); setRole('scorer'); setMaxUses('1'); setExpires(plusDays(30)); setError('') }
  const maxValid = maxUses === '' || (/^\d+$/.test(maxUses) && Number(maxUses) >= 1 && Number(maxUses) <= 10000)
  const valid = label.trim().length >= 1 && maxValid
  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    // Expiry at the end of the chosen day (Zurich local time of this device)
    const expiresAt = expires ? new Date(`${expires}T23:59:59`).toISOString() : null
    const res = await admin.createInvite({
      label: label.trim(),
      club: club.trim() || null,
      role,
      max_uses: maxUses === '' ? null : Number(maxUses),
      expires_at: expiresAt,
      // the code's sport is the console's app (left out: indoor, as before)
      ...(app ? { sport: app } : {})
    })
    setBusy(false)
    if (res.error || !res.data?.code) {
      setError(errorText(res.error || { status: 500 }))
      return
    }
    reset()
    onCreated(res.data)
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) { reset(); onClose() } }}
      decision
      dismissible={false}
      layout="sections"
      title={t('manage.invites.new')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={() => { reset(); onClose() }} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="create-invite">{t('manage.invites.create')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('manage.invites.label')} hint={t('manage.invites.labelHint')}>
          <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <Field label={t('manage.invites.club')}>
          <Input value={club} onChange={e => setClub(e.target.value)} maxLength={120} />
        </Field>
        <Field label={t('manage.invites.role')}>
          <Select value={role} onChange={e => setRole(e.target.value)}>
            {INVITE_ROLES.map(r => <option key={r} value={r}>{t(`access.roles.${r}`)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <Field label={t('manage.invites.maxUses')} hint={t('manage.invites.maxUsesHint')}>
            <Input type="number" inputMode="numeric" min={1} max={10000} value={maxUses} onChange={e => setMaxUses(e.target.value)} />
          </Field>
          <Field label={t('manage.invites.expires')}>
            <DateField value={expires} onChange={setExpires} />
          </Field>
        </div>
        <InlineError error={error} />
        <button type="submit" hidden />
      </form>
    </KitModal>
  )
}
