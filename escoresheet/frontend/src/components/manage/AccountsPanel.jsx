import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin, clubsApi } from '../../lib/accountApi'
import { API_GRANTABLE_ROLES, BEACH_ROLES, plainRole } from '../../lib/access'
import RoleChips from '../auth/RoleChips'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, personName, useErrorText } from './common'
import { SegmentedControl, SearchInput, RowList, Row, RowTool, EmptyInset, SkeletonRows, Button, Checkbox, Chip, Field, Input, Notice, dayLabel, confirmDialog, toast } from '../../ui'

// The destructive row tools (RowTool has no tone of its own): a red outline
// like the kit's danger-outline button. On a phone they take a line of their
// own under the others (four equal tools would cut "Approve as scorer"); from
// sm up Reject sits next to Approve and "Delete account" apart at the row's end.
const DANGER_TOOL = 'border-red-200 text-red-700 hover:bg-red-50 order-last basis-full sm:order-none sm:basis-auto'
const DELETE_TOOL = `${DANGER_TOOL} sm:ml-auto`

/**
 * Accounts: approve pending accounts, grant and revoke roles (admins).
 * `app` 'beach' (the OpenBeach manager): the members of OpenBeach, pending =
 * no beach role, and the beach roles only (shown by their plain names).
 * `app` 'indoor' (OpenVolley's console): the members of OpenVolley, indoor
 * roles. Left out: every account, indoor roles (as before).
 *
 * Deleting (POST /api/admin/accounts/:id/delete|reject): "Reject" on a
 * sign-up without any role (of any app: one login for both), "Delete account"
 * on every other account, behind a dialog that asks for its address. Never on
 * the admin's own row (Profile > Delete account), a super admin's only for a
 * super admin (`selfIsSuperAdmin`); the server checks all of it again. Only
 * when the server says it can (can_delete in the list): an older backend
 * shows the panel as before.
 */
export default function AccountsPanel({ selfId, selfIsSuperAdmin = false, app }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [filter, setFilter] = useState('pending')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [rowError, setRowError] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  // db/018: clubs (OpenVolley only; beach is not checked)
  const withClubs = app !== 'beach'
  const [clubsOf, setClubsOf] = useState(null)

  const scope = app ? { app } : {}
  const { data, error, loading, reload } = usePanelData(
    () => admin.listAccounts({ filter, q: query || undefined, ...scope }),
    [filter, query, app],
    { enabled: online }
  )
  const pending = usePanelData(() => admin.listAccounts({ filter: 'pending', ...scope }), [app], { enabled: online })
  const accounts = data?.accounts || []
  const pendingCount = pending.data?.accounts?.length ?? null
  const canDelete = data?.can_delete === true

  const roleError = (err) => {
    if (err?.code === 'OV_SELF_DEMOTE') return t('manage.accounts.selfDemote')
    if (err?.code === 'OV_FORBIDDEN') return t('manage.accounts.superAdminOnly')
    if (err?.code === 'OV_EMAIL_UNCONFIRMED') return t('manage.accounts.confirmEmailFirst')
    return errorText(err)
  }

  const approve = async (account) => {
    setBusyId(account.id)
    setRowError(e => ({ ...e, [account.id]: '' }))
    const res = await admin.setRoles(account.id, { add: [app === 'beach' ? 'beach:scorer' : 'scorer'], remove: [] })
    setBusyId(null)
    if (res.error) {
      setRowError(e => ({ ...e, [account.id]: roleError(res.error) }))
      return
    }
    toast.success(t('manage.accounts.saved'))
    reload()
    pending.reload()
  }

  // delete / reject: the account gone meanwhile, a server without the endpoint
  const deleteError = (err) => {
    if (err?.code === 'OV_ACCOUNT_NOT_FOUND') return t('manage.accounts.alreadyDeleted')
    if (err?.code === 'OV_NOT_FOUND') return t('manage.accounts.deleteUnavailable')
    if (err?.code === 'OV_FORBIDDEN') return t('manage.accounts.superAdminOnly')
    return errorText(err)
  }
  const afterDelete = () => { reload(); pending.reload() }

  const rejectSignUp = async (account) => {
    const ok = await confirmDialog({
      title: t('manage.accounts.rejectTitle', { name: personName(account.first_name, account.last_name, account.email) }),
      message: t('manage.accounts.rejectBody', { email: account.email }),
      confirmLabel: t('manage.accounts.reject'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    setBusyId(account.id)
    setRowError(e => ({ ...e, [account.id]: '' }))
    const res = await admin.rejectAccount(account.id, { email: account.email })
    setBusyId(null)
    if (res.error) {
      setRowError(e => ({ ...e, [account.id]: deleteError(res.error) }))
      if (res.error.code === 'OV_ACCOUNT_NOT_FOUND') afterDelete()
      return
    }
    toast.success(t('manage.accounts.rejected'))
    afterDelete()
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
              data-testid={`account-${a.id}`}
              stripe={false}
              // flex-wrap: the phone's line for Reject / Delete account (DANGER_TOOL)
              toolsIndent="flex-wrap sm:flex-nowrap sm:pl-2"
              actionIndent="pl-1.5"
              title={personName(a.first_name, a.last_name, a.email)}
              meta={<>
                <span className="break-all">{a.email}</span>
                <span>{t('manage.accounts.created', { date: date(a.created_at) })}</span>
                <span>{a.last_sign_in_at ? t('manage.accounts.lastSignIn', { date: date(a.last_sign_in_at) }) : t('manage.accounts.neverSignedIn')}</span>
                {a.email_confirmed === false && <span className="font-medium text-amber-700">{t('manage.accounts.emailUnconfirmed')}</span>}
              </>}
              chips={<>
                <RoleChips roles={a.roles} pending={a.pending} app={app} />
                {withClubs && (a.clubs || []).map(c => <Chip key={c.id} tone="sky">{c.name}</Chip>)}
              </>}
              tools={<>
                {a.pending && (
                  <RowTool primary disabled={!online || busyId === a.id} onClick={() => approve(a)}>{t('manage.accounts.approve')}</RowTool>
                )}
                {canDelete && deletion(a, selfId, selfIsSuperAdmin) === 'reject' && (
                  <RowTool className={DANGER_TOOL} disabled={!online || busyId === a.id} onClick={() => rejectSignUp(a)} data-testid="reject-account">{t('manage.accounts.reject')}</RowTool>
                )}
                <RowTool disabled={!online} onClick={() => setEditing(a)}>{t('manage.accounts.editRoles')}</RowTool>
                {withClubs && <RowTool disabled={!online} onClick={() => setClubsOf(a)}>{t('manage.accounts.editClubs')}</RowTool>}
                {canDelete && deletion(a, selfId, selfIsSuperAdmin) === 'delete' && (
                  <RowTool className={DELETE_TOOL} disabled={!online || busyId === a.id} onClick={() => setDeleting(a)} data-testid="delete-account">{t('manage.accounts.delete')}</RowTool>
                )}
                {rowError[a.id] && <InlineError error={rowError[a.id]} className="ml-1" />}
              </>}
            />
          ))}
        </RowList>
      )}
      <RolesModal
        app={app}
        account={editing}
        selfId={selfId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); pending.reload() }}
        roleError={roleError}
      />
      {clubsOf && (
        <ClubsModal
          account={clubsOf}
          onClose={() => setClubsOf(null)}
          onSaved={() => { setClubsOf(null); reload() }}
        />
      )}
      {deleting && (
        <DeleteAccountModal
          account={deleting}
          deleteError={deleteError}
          onClose={(gone) => { setDeleting(null); if (gone) afterDelete() }}
        />
      )}
    </section>
  )
}

/**
 * Which deletion a row offers: 'reject' (a sign-up without any role, of any
 * app), 'delete' (any other account), or null (the admin's own account; a
 * super admin's, unless the admin is one too).
 */
export function deletion(account, selfId, selfIsSuperAdmin = false) {
  if (!account || account.id === selfId) return null
  const roles = account.roles || []
  if (roles.length === 0) return 'reject'
  if (roles.includes('super_admin') && !selfIsSuperAdmin) return null
  return 'delete'
}

/**
 * "Delete account": what goes and what stays, and the account's address typed
 * as the confirmation (as Profile > Delete account asks for one's own).
 * onClose(true) once the account is gone (or was already).
 */
function DeleteAccountModal({ account, deleteError, onClose }) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = personName(account.first_name, account.last_name, account.email)
  const matches = typed.trim().toLowerCase() === String(account.email || '').trim().toLowerCase()
  const submit = async (e) => {
    e?.preventDefault()
    if (!matches || busy) return
    setBusy(true)
    setError('')
    const res = await admin.deleteAccount(account.id, { email: typed.trim() })
    setBusy(false)
    if (res.error) {
      if (res.error.code === 'OV_ACCOUNT_NOT_FOUND') {
        toast.info(t('manage.accounts.alreadyDeleted'))
        onClose(true)
        return
      }
      setError(deleteError(res.error))
      return
    }
    toast.success(t('manage.accounts.deleted', { name }))
    onClose(true)
  }
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose(false) }}
      decision
      dismissible={false}
      title={t('manage.accounts.deleteTitle', { name })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={() => onClose(false)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="danger" size="lg" onClick={submit} loading={busy} disabled={!matches || busy} data-testid="confirm-delete-account">{t('manage.accounts.deleteConfirm')}</Button>
      </>}
    >
      <p className="mb-3 text-sm text-stone-600">{t('manage.accounts.deleteBody')}</p>
      {/* What the server deletes and what it keeps (backend README "Deleting an account") */}
      <dl className="mb-3 space-y-2 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3 text-sm">
        <div>
          <dt className="font-semibold text-stone-800">{t('manage.accounts.deleteWhatGoesTitle')}</dt>
          <dd className="mt-0.5 text-stone-600">{t('manage.accounts.deleteWhatGoes')}</dd>
        </div>
        <div>
          <dt className="font-semibold text-stone-800">{t('manage.accounts.deleteWhatStaysTitle')}</dt>
          <dd className="mt-0.5 text-stone-600">{t('manage.accounts.deleteWhatStays')}</dd>
        </div>
      </dl>
      <form onSubmit={submit}>
        <Field label={t('manage.accounts.deleteTypeEmail', { email: account.email })}>
          <Input
            type="email"
            value={typed}
            onChange={e => { setTyped(e.target.value); setError('') }}
            placeholder={account.email}
            autoComplete="off"
            spellCheck={false}
            data-testid="delete-account-email"
          />
        </Field>
      </form>
      <InlineError error={error} className="mt-1.5" />
    </KitModal>
  )
}

/** db/018: the clubs an account scores for (the home games of these clubs). */
function ClubsModal({ account, onClose, onSaved }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const list = usePanelData(() => clubsApi.list(), [])
  const [picked, setPicked] = useState(() => new Set((account.clubs || []).map(c => c.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clubs = list.data?.clubs || []
  const toggle = (id) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
    setError('')
  }
  const save = async () => {
    if (busy) return
    setBusy(true)
    const res = await admin.setAccountClubs(account.id, [...picked])
    setBusy(false)
    if (res.error) {
      setError(errorText(res.error))
      return
    }
    toast.success(t('manage.accounts.saved'))
    onSaved()
  }
  const name = personName(account.first_name, account.last_name, account.email)
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      decision
      title={t('manage.accounts.clubsTitle', { name })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || !list.data} data-testid="save-account-clubs">{t('manage.accounts.save')}</Button>
      </>}
    >
      <p className="mb-2 text-xs text-stone-600">{t('manage.accounts.clubsHint')}</p>
      {list.error && <Notice className="mb-2">{errorText(list.error)}</Notice>}
      {list.loading && !list.data ? (
        <SkeletonRows rows={3} pill={false} />
      ) : clubs.length === 0 ? (
        <EmptyInset>{t('manage.accounts.noClubsYet')}</EmptyInset>
      ) : (
        <div className="flex flex-col gap-1.5">
          {clubs.map(c => (
            <Checkbox key={c.id} label={c.name} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
          ))}
        </div>
      )}
      <InlineError error={error} className="mt-2" />
    </KitModal>
  )
}

function RolesModal({ app, account, onClose, onSaved, roleError }) {
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
  // OpenBeach's console grants the beach roles only (the global admin role is
  // managed in OpenVolley's); a role of the other app is never sent
  const grantable = app === 'beach' ? BEACH_ROLES : API_GRANTABLE_ROLES
  const add = grantable.filter(r => current.has(r) && !initial.has(r))
  const remove = grantable.filter(r => !current.has(r) && initial.has(r))
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
        {grantable.map(role => (
          <Checkbox key={role} label={t(`access.roles.${plainRole(role)}`)} checked={current.has(role)} onChange={() => toggle(role)} />
        ))}
        {initial.has('super_admin') && <Checkbox label={t('access.roles.super_admin')} checked disabled readOnly />}
      </div>
      <InlineError error={error} className="mt-2" />
    </KitModal>
  )
}
