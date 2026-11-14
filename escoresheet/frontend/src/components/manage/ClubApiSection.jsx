import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Plus } from 'lucide-react'
import { clubApi } from '../../lib/accountApi'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, Checkbox, Chip, EmptyInset, Field, Input, ModalStrip, Notice, Row, RowList, RowTool, Select, SkeletonRows, StatusPill, confirmDialog, dayLabel, toast } from '../../ui'

// lib/clubApi.js SCOPES: read, and what a token may write
export const API_SCOPES = ['read', 'rosters:write', 'teams:write', 'licences:write']
export const WRITE_SCOPES = ['rosters:write', 'teams:write', 'licences:write']
const API_BASE = 'https://backend.openvolley.app/api/club/v1'

/** The curl line shown with a new token: the club's teams, with its token. */
export const curlSnippet = (token) => `curl -H "Authorization: Bearer ${token}" ${API_BASE}/teams`

/**
 * My club → API (db/032, lib/clubApi.js, docs/club-api.md): the club's API
 * tokens. A token is shown once; it acts for this club (or one team) with the
 * scopes picked here, as the manager who makes it. A token that can write asks
 * for the account password. Embedding live scores on a website needs no token:
 * the public widget does it (docs/public-api.md).
 */
export default function ClubApiSection({ club }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null) // { token, ... } shown once
  const [rowError, setRowError] = useState({})
  const { data, error, loading, reload } = usePanelData(() => clubApi.apiTokens(club.id), [club.id], { enabled: online })
  const tokens = data?.tokens || []

  const revoke = async (tok) => {
    const ok = await confirmDialog({
      title: t('manage.myClub.api.revokeTitle'),
      message: t('manage.myClub.api.revokeBody'),
      confirmLabel: t('manage.myClub.api.revoke'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await clubApi.revokeApiToken(club.id, tok.id)
    if (res.error) {
      setRowError((e) => ({ ...e, [tok.id]: errorText(res.error) }))
      return
    }
    reload()
  }
  const state = (tok) => (tok.revoked_at ? 'revoked' : tok.expires_at && new Date(tok.expires_at) <= new Date() ? 'expired' : 'active')

  return (
    <section data-testid="club-api">
      <PanelHead title={t('manage.myClub.api.title')} level={2}>
        <Button icon={Plus} onClick={() => setCreating(true)} disabled={!online}>{t('manage.myClub.api.new')}</Button>
      </PanelHead>
      <p className="mb-3 text-sm text-stone-500">{t('manage.myClub.api.intro')}</p>
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : loading && !data ? (
        <SkeletonRows rows={3} pill={false} />
      ) : tokens.length === 0 ? (
        <EmptyInset>{t('manage.myClub.api.empty')}</EmptyInset>
      ) : (
        <RowList>
          {tokens.map((tok) => {
            const s = state(tok)
            return (
              <Row
                key={tok.id}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={tok.label}
                status={<StatusPill tone={s === 'active' ? 'done' : 'neutral'}>{t(`manage.myClub.api.state.${s}`)}</StatusPill>}
                meta={<>
                  <span className="font-mono tabular-nums">{tok.prefix}…</span>
                  <span>{tok.last_used_at ? t('manage.myClub.api.lastUsed', { date: dayLabel(tok.last_used_at, { year: true }) }) : t('manage.myClub.api.neverUsed')}</span>
                  {tok.expires_at && <span>{t('manage.myClub.api.expires')} {dayLabel(tok.expires_at, { year: true })}</span>}
                </>}
                chips={<>{tok.scopes.map((sc) => <Chip key={sc} tone={sc === 'read' ? undefined : 'indigo'}>{sc}</Chip>)}</>}
                tools={s === 'active' || rowError[tok.id] ? <>
                  {s === 'active' && <RowTool disabled={!online} onClick={() => revoke(tok)}>{t('manage.myClub.api.revoke')}</RowTool>}
                  <InlineError error={rowError[tok.id]} className="ml-1" />
                </> : null}
              />
            )
          })}
        </RowList>
      )}
      <CreateTokenModal club={club} open={creating} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setCreated(r); reload() }} />
      <KitModal
        open={!!created}
        onClose={() => setCreated(null)}
        decision
        dismissible={false}
        layout="sections"
        title={t('manage.myClub.api.createdTitle')}
        closeLabel={t('common.close', 'Close')}
        footer={<Button variant="dark" size="lg" onClick={() => setCreated(null)}>{t('common.close', 'Close')}</Button>}
      >
        <ModalStrip>{t('manage.myClub.api.createdOnce')}</ModalStrip>
        <div className="flex flex-col items-stretch gap-2 min-[420px]:flex-row min-[420px]:items-center">
          <output data-testid="api-token" className="flex-1 select-all break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-xs text-stone-900">{created?.token}</output>
          <Button
            variant="secondary"
            icon={Copy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created?.token || '')
                toast.success(t('manage.myClub.api.copied'))
              } catch { /* no clipboard: the token stays selectable */ }
            }}
          >
            {t('manage.myClub.api.copy')}
          </Button>
        </div>
        <p className="text-xs text-stone-500">{t('manage.myClub.api.example')}</p>
        <pre className="select-all overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs text-stone-800">{curlSnippet(created?.token || '')}</pre>
      </KitModal>
    </section>
  )
}

function CreateTokenModal({ club, open, onClose, onCreated }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState(['read'])
  const [teamId, setTeamId] = useState('')
  const [days, setDays] = useState('365')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const teamList = usePanelData(() => (open ? clubApi.teams(club.id) : Promise.resolve({ data: null })), [open, club.id])
  const teams = [...(teamList.data?.teams || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const writes = WRITE_SCOPES.some((s) => scopes.includes(s))
  const daysOk = days === '' || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 730)
  const valid = label.trim().length >= 1 && scopes.length > 0 && daysOk && (!writes || password.length > 0)
  const reset = () => { setLabel(''); setScopes(['read']); setTeamId(''); setDays('365'); setPassword(''); setError('') }
  const toggle = (s) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    const res = await clubApi.createApiToken(club.id, {
      label: label.trim(),
      scopes,
      ...(teamId ? { team_id: teamId } : {}),
      ...(days !== '' ? { expires_in_days: Number(days) } : {}),
      ...(writes ? { password } : {})
    })
    setBusy(false)
    if (res.error || !res.data?.token) {
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
      title={t('manage.myClub.api.new')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={() => { reset(); onClose() }} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="create-api-token">{t('manage.myClub.api.create')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('manage.myClub.api.label')} hint={t('manage.myClub.api.labelHint')}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required autoFocus />
        </Field>
        <Field label={t('manage.myClub.api.scopes')}>
          <div className="space-y-2">
            {API_SCOPES.map((s) => (
              <Checkbox key={s} label={s} hint={t(`manage.myClub.api.scope.${s}`)} checked={scopes.includes(s)} onChange={() => toggle(s)} disabled={s === 'read' && writes} />
            ))}
          </div>
        </Field>
        <Field label={t('manage.myClub.api.team')} hint={t('manage.myClub.api.teamHint')}>
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{t('manage.myClub.api.wholeClub')}</option>
            {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </Select>
        </Field>
        <Field label={t('manage.myClub.api.days')} hint={t('manage.myClub.api.daysHint')}>
          <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        {writes && (
          <Field label={t('manage.myClub.api.password')} hint={t('manage.myClub.api.passwordHint')}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <InlineError error={error} />
      </form>
    </KitModal>
  )
}
