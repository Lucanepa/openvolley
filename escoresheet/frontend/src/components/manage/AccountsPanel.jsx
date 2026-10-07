import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { API_GRANTABLE_ROLES } from '../../lib/access'
import RoleChips from '../auth/RoleChips'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, personName, useErrorText } from './common'
import { SegmentedControl, SearchInput, RowList, Row, RowTool, EmptyInset, SkeletonRows, Button, Checkbox, Notice, dayLabel, toast } from '../../ui'

/** Accounts: approve pending accounts, grant and revoke roles (admins). */
export default function AccountsPanel({ selfId }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [filter, setFilter] = useState('pending')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [rowError, setRowError] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [editing, setEditing] = useState(null)

  const { data, error, loading, reload } = usePanelData(
    () => admin.listAccounts({ filter, q: query || undefined }),
    [filter, query],
    { enabled: online }
  )
  const pending = usePanelData(() => admin.listAccounts({ filter: 'pending' }), [], { enabled: online })
  const accounts = data?.accounts || []
  const pendingCount = pending.data?.accounts?.length ?? null

  const roleError = (err) => {
    if (err?.code === 'OV_SELF_DEMOTE') return t('manage.accounts.selfDemote')
    if (err?.code === 'OV_FORBIDDEN') return t('manage.accounts.superAdminOnly')
    if (err?.code === 'OV_EMAIL_UNCONFIRMED') return t('manage.accounts.confirmEmailFirst')
    return errorText(err)
  }

  const approve = async (account) => {
    setBusyId(account.id)
    setRowError(e => ({ ...e, [account.id]: '' }))
    const res = await admin.setRoles(account.id, { add: ['scorer'], remove: [] })
    setBusyId(null)
    if (res.error) {
      setRowError(e => ({ ...e, [account.id]: roleError(res.error) }))
      return
    }
    toast.success(t('manage.accounts.saved'))
    reload()
    pending.reload()
  }

  const date = (v) => (v ? dayLabel(v, { year: true }) : '')

  return (
    <section>
      <PanelHead title={t('manage.tabs.accounts')} />
      <OfflineBanner online={online} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SegmentedControl
          ariaLabel={t('manage.tabs.accounts')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: pendingCount ? `${t('manage.accounts.filterPending')} (${pendingCount})` : t('manage.accounts.filterPending') },
            { value: 'all', label: t('manage.accounts.filterAll') }
          ]}
        />
        <form className="sm:ml-auto sm:w-80" onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }}>
          <SearchInput size="md" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setQuery('') }} placeholder={t('manage.accounts.search')} aria-label={t('manage.accounts.search')} maxLength={80} />
        </form>
      </div>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={5} pill={false} />
      ) : accounts.length === 0 ? (
        <EmptyInset>{filter === 'pending' ? t('manage.accounts.emptyPending') : t('manage.accounts.empty')}</EmptyInset>
      ) : (
        <RowList>
          {accounts.map(a => (
            <Row
              key={a.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={personName(a.first_name, a.last_name, a.email)}
              meta={<>
                <span className="break-all">{a.email}</span>
                <span>{t('manage.accounts.created', { date: date(a.created_at) })}</span>
                <span>{a.last_sign_in_at ? t('manage.accounts.lastSignIn', { date: date(a.last_sign_in_at) }) : t('manage.accounts.neverSignedIn')}</span>
                {a.email_confirmed === false && <span className="font-medium text-amber-700">{t('manage.accounts.emailUnconfirmed')}</span>}
              </>}
              chips={<RoleChips roles={a.roles} pending={a.pending} />}
              tools={<>
                {a.pending && (
                  <RowTool primary disabled={!online || busyId === a.id} onClick={() => approve(a)}>{t('manage.accounts.approve')}</RowTool>
                )}
                <RowTool disabled={!online} onClick={() => setEditing(a)}>{t('manage.accounts.editRoles')}</RowTool>
                {rowError[a.id] && <InlineError error={rowError[a.id]} className="ml-1" />}
              </>}
            />
          ))}
        </RowList>
      )}
      <RolesModal
        account={editing}
        selfId={selfId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); pending.reload() }}
        roleError={roleError}
      />
    </section>
  )
}

function RolesModal({ account, onClose, onSaved, roleError }) {
  const { t } = useTranslation()
  const initial = useMemo(() => new Set(account?.roles || []), [account])
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = picked ?? initial
  if (!account) return null
  const toggle = (role) => {
    const next = new Set(current)
    if (next.has(role)) next.delete(role)
    else next.add(role)
    setPicked(next)
    setError('')
  }
  const add = API_GRANTABLE_ROLES.filter(r => current.has(r) && !initial.has(r))
  const remove = API_GRANTABLE_ROLES.filter(r => !current.has(r) && initial.has(r))
  const save = async () => {
    if (busy || (!add.length && !remove.length)) return
    setBusy(true)
    const res = await admin.setRoles(account.id, { add, remove })
    setBusy(false)
    if (res.error) {
      setError(roleError(res.error))
      return
    }
    toast.success(t('manage.accounts.saved'))
    setPicked(null)
    onSaved()
  }
  const close = () => { if (!busy) { setPicked(null); setError(''); onClose() } }
  const name = personName(account.first_name, account.last_name, account.email)
  return (
    <KitModal
      open
      onClose={close}
      decision
      title={t('manage.accounts.rolesTitle', { name })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={close} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || (!add.length && !remove.length)}>{t('manage.accounts.save')}</Button>
      </>}
    >
      <div className="flex flex-col gap-1.5">
        {API_GRANTABLE_ROLES.map(role => (
          <Checkbox key={role} label={t(`access.roles.${role}`)} checked={current.has(role)} onChange={() => toggle(role)} />
        ))}
        {initial.has('super_admin') && <Checkbox label={t('access.roles.super_admin')} checked disabled readOnly />}
      </div>
      <InlineError error={error} className="mt-2" />
    </KitModal>
  )
}
