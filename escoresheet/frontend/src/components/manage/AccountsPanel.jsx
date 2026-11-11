import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { admin, clubsApi, fetchPublicClubs } from '../../lib/accountApi'
import { API_GRANTABLE_ROLES, BEACH_ROLES, plainRole } from '../../lib/access'
import { requestPartLabel, sortRequestParts } from '../../domain/signUpRequests'
import RoleChips from '../auth/RoleChips'
import KitModal from './KitModal'
import { usePanelData, usePanelRoute, useOnline, OfflineBanner, PageMissing, PanelHead, InlineError, personName, useErrorText } from './common'
import { usePageItem } from './usePageItem'
import { SegmentedControl, SearchInput, RowList, Row, RowTool, EmptyInset, KeyValue, SkeletonRows, Button, Checkbox, Chip, Field, Input, Notice, Select, dayLabel, confirmDialog, toast } from '../../ui'

// The destructive row tools (RowTool has no tone of its own): a red outline
// like the kit's danger-outline button. On a phone they take a line of their
// own under the others (four equal tools would cut "Approve as scorer"); from
// sm up Reject sits next to Approve and "Delete account" apart at the row's end.
const DANGER_TOOL = 'border-red-200 text-red-700 hover:bg-red-50 order-last basis-full sm:order-none sm:basis-auto'
const DELETE_TOOL = `${DANGER_TOOL} sm:ml-auto`

/**
 * The read behind an account's page that is in neither list (opened from a
 * link, the Pending filter or a search showing others, or approved on its
 * page): there is no read of one account, so every account of the app (the
 * server's most, 500) and the one with this id.
 */
export function findAccount(id, app) {
  return admin.listAccounts({ filter: 'all', limit: 500, ...(app ? { app } : {}) }).then((res) => (
    res.error ? res : { data: (res.data?.accounts || []).find(a => a.id === id) || null, error: null }
  ))
}

/**
 * Accounts: approve pending accounts, grant and revoke roles, change an
 * account's name and address (admins).
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
 *
 * Sign-up requests (db/025, OpenVolley): a row whose account asked for
 * something at sign-up shows each part ("Scorer · VBC Musterdorf") and offers
 * "Approve as requested" (every part, one click) and "Review request" (untick
 * a part, leave it for later, reject it, or change its club or team first).
 * The Pending filter lists these accounts too, also after a club's or a
 * team's manager approved a part (the account is no longer pending then).
 *
 * An account is a page of its own (owner 2026-11-10: "make sure every page
 * there gets their own page"): #accounts/<account id>, with what its row
 * says and the same actions; roles, clubs, the request review and deleting
 * stay dialogs, opened from the page as from the row (usePanelRoute).
 */
export default function AccountsPanel({ selfId, selfIsSuperAdmin = false, app, route = '', onRoute = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [filter, setFilter] = useState('pending')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [rowError, setRowError] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [editing, setEditing] = useState(null)
  const [detailsOf, setDetailsOf] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [reviewing, setReviewing] = useState(null)
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
  // PATCH /api/admin/accounts/:id (name and address): only on a server that has it
  const canEdit = data?.can_edit === true

  const [[pageId = null], go] = usePanelRoute(route, onRoute)
  const page = usePageItem(pageId, {
    found: pageId ? (accounts.find(a => a.id === pageId) || (pending.data?.accounts || []).find(a => a.id === pageId) || null) : null,
    ready: !!data && !loading && !pending.loading,
    lookup: (id) => findAccount(id, app),
    enabled: online,
    deps: [app]
  })
  // the account's page is gone with the account: back to the list, in place of the page's history entry
  const leavePage = (account) => { if (pageId && account?.id === pageId) go([], { push: false }) }

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

  // db/025: every part of the account's sign-up request, as asked
  const approveAsRequested = async (account) => {
    setBusyId(account.id)
    setRowError(e => ({ ...e, [account.id]: '' }))
    const res = await admin.decideRequests(account.id, { approve: (account.requests || []).map(p => ({ id: p.id })) })
    setBusyId(null)
    if (res.error) {
      if (res.error.code === 'OV_REQUEST_GONE') {
        toast.info(t('manage.requests.gone'))
        reload()
        pending.reload()
        return
      }
      setRowError(e => ({ ...e, [account.id]: roleError(res.error) }))
      return
    }
    toast.success(t('manage.requests.approved'))
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
      if (res.error.code === 'OV_ACCOUNT_NOT_FOUND') { afterDelete(); leavePage(account) }
      return
    }
    toast.success(t('manage.accounts.rejected'))
    afterDelete()
    leavePage(account)
  }

  const date = (v) => (v ? dayLabel(v, { year: true }) : '')
  // what the row and the page offer to delete: 'reject', 'delete' or nothing
  const offer = (a) => (canDelete ? deletion(a, selfId, selfIsSuperAdmin) : null)
  const actions = {
    approve,
    approveAsRequested,
    review: setReviewing,
    reject: rejectSignUp,
    editRoles: setEditing,
    editDetails: canEdit ? setDetailsOf : null,
    editClubs: withClubs ? setClubsOf : null,
    remove: setDeleting
  }

  const dialogs = <>
    {detailsOf && (
      <DetailsModal
        account={detailsOf}
        selfIsSuperAdmin={selfIsSuperAdmin}
        onClose={() => setDetailsOf(null)}
        onSaved={() => { setDetailsOf(null); reload(); pending.reload() }}
      />
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
    {reviewing && (
      <RequestReviewModal
        account={reviewing}
        roleError={roleError}
        onClose={(changed) => { setReviewing(null); if (changed) { reload(); pending.reload() } }}
      />
    )}
    {deleting && (
      <DeleteAccountModal
        account={deleting}
        deleteError={deleteError}
        onClose={(gone) => { const account = deleting; setDeleting(null); if (gone) { afterDelete(); leavePage(account) } }}
      />
    )}
  </>

  // the account's page
  if (pageId) {
    return (
      <>
        {page.item ? (
          <AccountPage
            key={pageId}
            account={page.item}
            app={app}
            withClubs={withClubs}
            online={online}
            busy={busyId === page.item.id}
            error={rowError[page.item.id]}
            offer={offer(page.item)}
            actions={actions}
            selfIsSuperAdmin={selfIsSuperAdmin}
            onBack={() => go([])}
          />
        ) : (
          <PageMissing loading={page.loading} error={page.error || error} onBack={() => go([])} backLabel={t('manage.tabs.accounts')} />
        )}
        {dialogs}
      </>
    )
  }

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
          {accounts.map(a => {
            const name = personName(a.first_name, a.last_name, a.email)
            return (
              <Row
                key={a.id}
                data-testid={`account-${a.id}`}
                stripe={false}
                // flex-wrap: the phone's line for Reject / Delete account (DANGER_TOOL)
                toolsIndent="flex-wrap sm:flex-nowrap sm:pl-2"
                actionIndent="pl-1.5"
                title={name}
                label={name}
                onOpen={() => go([a.id])}
                meta={<>
                  <span className="break-all">{a.email}</span>
                  <span>{t('manage.accounts.created', { date: date(a.created_at) })}</span>
                  <span>{a.last_sign_in_at ? t('manage.accounts.lastSignIn', { date: date(a.last_sign_in_at) }) : t('manage.accounts.neverSignedIn')}</span>
                  {a.email_confirmed === false && <span className="font-medium text-amber-700">{t('manage.accounts.emailUnconfirmed')}</span>}
                </>}
                chips={<>
                  <RoleChips roles={a.roles} pending={a.pending} app={app} />
                  {withClubs && (a.clubs || []).map(c => <Chip key={c.id} tone="sky">{c.name}</Chip>)}
                  {/* db/020 / db/023: what the account manages */}
                  {(a.managed_clubs || []).map(c => <Chip key={`mc-${c.id}`} tone="indigo">{t('manage.requests.managesClub', { name: c.name })}</Chip>)}
                  {(a.managed_teams || []).map(x => <Chip key={`mt-${x.id}`} tone="indigo">{t('manage.requests.managesTeam', { name: x.name })}</Chip>)}
                  {/* db/025: what it asked for at sign-up and is still open */}
                  {sortRequestParts(a.requests).map(p => <Chip key={p.id} tone="amber">{t('manage.requests.asks', { part: requestPartLabel(p, t) })}</Chip>)}
                </>}
                tools={<>
                  {(a.requests || []).length > 0 ? (
                    <>
                      <RowTool primary disabled={!online || busyId === a.id} onClick={() => approveAsRequested(a)} data-testid="approve-as-requested">{t('manage.requests.approveAll')}</RowTool>
                      <RowTool disabled={!online || busyId === a.id} onClick={() => setReviewing(a)} data-testid="review-request">{t('manage.requests.review')}</RowTool>
                    </>
                  ) : a.pending && (
                    <RowTool primary disabled={!online || busyId === a.id} onClick={() => approve(a)}>{t('manage.accounts.approve')}</RowTool>
                  )}
                  {offer(a) === 'reject' && (
                    <RowTool className={DANGER_TOOL} disabled={!online || busyId === a.id} onClick={() => rejectSignUp(a)} data-testid="reject-account">{t('manage.accounts.reject')}</RowTool>
                  )}
                  {canEdit && canEditDetails(a, selfIsSuperAdmin) && <RowTool disabled={!online} onClick={() => setDetailsOf(a)} data-testid="edit-details">{t('manage.accounts.editDetails')}</RowTool>}
                  <RowTool disabled={!online} onClick={() => setEditing(a)}>{t('manage.accounts.editRoles')}</RowTool>
                  {withClubs && <RowTool disabled={!online} onClick={() => setClubsOf(a)}>{t('manage.accounts.editClubs')}</RowTool>}
                  {offer(a) === 'delete' && (
                    <RowTool className={DELETE_TOOL} disabled={!online || busyId === a.id} onClick={() => setDeleting(a)} data-testid="delete-account">{t('manage.accounts.delete')}</RowTool>
                  )}
                  {rowError[a.id] && <InlineError error={rowError[a.id]} className="ml-1" />}
                </>}
              />
            )
          })}
        </RowList>
      )}
      {dialogs}
    </section>
  )
}

/**
 * An account's page: its name, address, dates, roles, clubs, what it manages
 * and its open sign-up request, with the row's actions at the card's foot
 * (`actions` from the panel; `offer` = deletion()).
 */
function AccountPage({ account: a, app, withClubs, online, busy, error, offer, actions, selfIsSuperAdmin = false, onBack }) {
  const { t } = useTranslation()
  const name = personName(a.first_name, a.last_name, a.email)
  const date = (v) => (v ? dayLabel(v, { year: true }) : '–')
  const parts = sortRequestParts(a.requests)
  const managed = [
    ...(a.managed_clubs || []).map(c => <Chip key={`mc-${c.id}`} tone="indigo">{t('manage.requests.managesClub', { name: c.name })}</Chip>),
    ...(a.managed_teams || []).map(x => <Chip key={`mt-${x.id}`} tone="indigo">{t('manage.requests.managesTeam', { name: x.name })}</Chip>)
  ]
  const chips = (nodes) => <span className="flex flex-wrap gap-1.5">{nodes}</span>
  const groups = [
    { label: t('manage.accounts.page.roles'), value: <RoleChips roles={a.roles} pending={a.pending} app={app} /> },
    ...(withClubs ? [{ label: t('manage.accounts.page.clubs'), value: (a.clubs || []).length ? chips(a.clubs.map(c => <Chip key={c.id} tone="sky">{c.name}</Chip>)) : '–' }] : []),
    ...(managed.length ? [{ label: t('manage.accounts.page.manages'), value: chips(managed) }] : []),
    ...(parts.length ? [{ label: t('manage.accounts.page.request'), value: chips(parts.map(p => <Chip key={p.id} tone="amber">{requestPartLabel(p, t)}</Chip>)) }] : [])
  ]
  return (
    <section data-testid="account-page">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} disabled={busy} className="mb-3" data-testid="account-page-back">{t('manage.tabs.accounts')}</Button>
      <PanelHead title={name} />
      <OfflineBanner online={online} />
      <div className="rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5" data-testid="account-facts">
        <KeyValue
          variant="stats"
          className="gap-y-3 text-sm"
          items={[
            { label: t('manage.accounts.page.email'), value: <span className="break-all">{a.email}</span> },
            { label: t('manage.accounts.page.created'), value: date(a.created_at) },
            { label: t('manage.accounts.page.lastSignIn'), value: a.last_sign_in_at ? date(a.last_sign_in_at) : t('manage.accounts.neverSignedIn') }
          ]}
        />
        {a.email_confirmed === false && <p className="mt-2 text-xs font-medium text-amber-700">{t('manage.accounts.emailUnconfirmed')}</p>}
        <KeyValue variant="stacked" className="mt-4" items={groups} />
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4">
          {parts.length > 0 ? (
            <>
              <Button variant="positive" disabled={!online || busy} loading={busy} onClick={() => actions.approveAsRequested(a)} data-testid="approve-as-requested">{t('manage.requests.approveAll')}</Button>
              <Button variant="secondary" disabled={!online || busy} onClick={() => actions.review(a)} data-testid="review-request">{t('manage.requests.review')}</Button>
            </>
          ) : a.pending && (
            <Button variant="positive" disabled={!online || busy} loading={busy} onClick={() => actions.approve(a)} data-testid="approve-account">{t('manage.accounts.approve')}</Button>
          )}
          {actions.editDetails && canEditDetails(a, selfIsSuperAdmin) && <Button variant="secondary" disabled={!online} onClick={() => actions.editDetails(a)} data-testid="edit-details">{t('manage.accounts.editDetails')}</Button>}
          <Button variant="secondary" disabled={!online} onClick={() => actions.editRoles(a)} data-testid="edit-roles">{t('manage.accounts.editRoles')}</Button>
          {actions.editClubs && <Button variant="secondary" disabled={!online} onClick={() => actions.editClubs(a)} data-testid="edit-clubs">{t('manage.accounts.editClubs')}</Button>}
          {offer === 'reject' && (
            <Button variant="danger-outline" className="sm:ml-auto" disabled={!online || busy} onClick={() => actions.reject(a)} data-testid="reject-account">{t('manage.accounts.reject')}</Button>
          )}
          {offer === 'delete' && (
            <Button variant="danger-outline" className="sm:ml-auto" disabled={!online || busy} onClick={() => actions.remove(a)} data-testid="delete-account">{t('manage.accounts.delete')}</Button>
          )}
        </div>
        <InlineError error={error} className="mt-2" />
      </div>
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
  // a club or team it manages (db/020, db/023): somebody approved it, so it is deleted, not rejected
  const manages = (account.managed_clubs || []).length > 0 || (account.managed_teams || []).length > 0
  if (roles.length === 0 && !manages) return 'reject'
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

/**
 * db/025: an admin's look at one account's sign-up request. Each part:
 * Approve (as asked, or with another club / team picked here), Later (it stays
 * for the club's or the team's managers) or Reject. onClose(true) after a save.
 */
function RequestReviewModal({ account, roleError, onClose }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const clubs = usePanelData(() => fetchPublicClubs(), [])
  const parts = useMemo(() => sortRequestParts(account.requests), [account])
  const [choice, setChoice] = useState(() => Object.fromEntries(parts.map(p => [p.id, { decision: 'approve', club_id: p.club_id || '', team_id: p.team_id || '' }])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const list = clubs.data?.clubs || []
  const set = (id, patch) => { setChoice(c => ({ ...c, [id]: { ...c[id], ...patch } })); setError('') }
  const approve = parts.filter(p => choice[p.id].decision === 'approve').map(p => {
    const c = choice[p.id]
    const item = { id: p.id }
    if (p.kind === 'team_manager' && c.team_id && c.team_id !== p.team_id) item.team_id = c.team_id
    if ((p.kind === 'scorer' || p.kind === 'club_manager') && c.club_id && c.club_id !== p.club_id) item.club_id = c.club_id
    return item
  })
  const reject = parts.filter(p => choice[p.id].decision === 'reject').map(p => p.id)
  const incomplete = parts.some(p => choice[p.id].decision === 'approve' && p.kind === 'team_manager' && !choice[p.id].team_id)
  const save = async () => {
    if (busy || incomplete || (!approve.length && !reject.length)) return
    setBusy(true)
    const res = await admin.decideRequests(account.id, { approve, reject })
    setBusy(false)
    if (res.error) {
      if (res.error.code === 'OV_REQUEST_GONE') {
        toast.info(t('manage.requests.gone'))
        onClose(true)
        return
      }
      setError(roleError ? roleError(res.error) : errorText(res.error))
      return
    }
    toast.success(t('manage.requests.saved'))
    onClose(true)
  }
  const name = personName(account.first_name, account.last_name, account.email)
  const clubOptions = list.map(c => ({ value: c.id, label: c.name }))
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose(false) }}
      decision
      title={t('manage.requests.reviewTitle', { name })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={() => onClose(false)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || incomplete || (!approve.length && !reject.length)} data-testid="save-request-review">{t('manage.accounts.save')}</Button>
      </>}
    >
      <p className="mb-3 text-xs text-stone-600">{t('manage.requests.reviewHint')}</p>
      {clubs.error && <Notice className="mb-2">{errorText(clubs.error)}</Notice>}
      <div className="flex flex-col gap-3">
        {parts.map(p => {
          const c = choice[p.id]
          const club = list.find(x => x.id === c.club_id)
          return (
            <div key={p.id} className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3" data-testid={`review-part-${p.id}`}>
              <p className="mb-2 text-sm font-medium text-stone-800">{requestPartLabel(p, t)}</p>
              <SegmentedControl
                ariaLabel={requestPartLabel(p, t)}
                value={c.decision}
                onChange={(v) => set(p.id, { decision: v })}
                options={[
                  { value: 'approve', label: t('manage.requests.decision.approve') },
                  { value: 'later', label: t('manage.requests.decision.later') },
                  { value: 'reject', label: t('manage.requests.decision.reject') }
                ]}
              />
              {c.decision === 'approve' && p.kind !== 'referee' && list.length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label={t('manage.requests.club')} tone="compact">
                    <Select block value={c.club_id} options={clubOptions} onChange={e => set(p.id, { club_id: e.target.value, ...(p.kind === 'team_manager' ? { team_id: '' } : {}) })} data-testid={`review-club-${p.id}`} />
                  </Field>
                  {p.kind === 'team_manager' && (
                    <Field label={t('manage.requests.team')} tone="compact">
                      <Select
                        block
                        value={c.team_id}
                        placeholder={t('manage.requests.pickTeam')}
                        options={(club?.teams || []).map(x => ({ value: x.id, label: x.name }))}
                        onChange={e => set(p.id, { team_id: e.target.value })}
                        data-testid={`review-team-${p.id}`}
                      />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <InlineError error={error} className="mt-2" />
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

/** A super admin's details only by a super admin (the server checks the same). */
export function canEditDetails(account, selfIsSuperAdmin = false) {
  return !!account && (selfIsSuperAdmin || !(account.roles || []).includes('super_admin'))
}

/**
 * An account's name and address (owner 2026-11-11: "let me modify them (e.g.
 * names etc)"): PATCH /api/admin/accounts/:id with the fields changed. The
 * password, passkeys and the address's confirmation stay.
 */
function DetailsModal({ account, onClose, onSaved }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [form, setForm] = useState(() => ({ first_name: account.first_name || '', last_name: account.last_name || '', email: account.email || '' }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setError('') }
  const changed = {}
  for (const k of ['first_name', 'last_name']) if (form[k].trim() !== (account[k] || '')) changed[k] = form[k].trim()
  if (form.email.trim().toLowerCase() !== String(account.email || '').toLowerCase()) changed.email = form.email.trim()
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
  const save = async () => {
    if (busy || !Object.keys(changed).length || !emailOk) return
    setBusy(true)
    const res = await admin.updateAccount(account.id, changed)
    setBusy(false)
    if (res.error) {
      setError(res.error.code === 'OV_EMAIL_TAKEN' ? t('manage.accounts.emailTaken') : errorText(res.error))
      return
    }
    toast.success(t('manage.accounts.saved'))
    onSaved()
  }
  const close = () => { if (!busy) onClose() }
  const name = personName(account.first_name, account.last_name, account.email)
  return (
    <KitModal
      open
      onClose={close}
      decision
      title={t('manage.accounts.detailsTitle', { name })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={close} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || !Object.keys(changed).length || !emailOk} data-testid="save-account-details">{t('manage.accounts.save')}</Button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('manage.accounts.firstName')}>
          <Input value={form.first_name} onChange={set('first_name')} maxLength={80} autoComplete="off" data-testid="account-first-name" />
        </Field>
        <Field label={t('manage.accounts.lastName')}>
          <Input value={form.last_name} onChange={set('last_name')} maxLength={80} autoComplete="off" data-testid="account-last-name" />
        </Field>
        <Field label={t('manage.accounts.email')} hint={changed.email ? t('manage.accounts.emailHint') : undefined}>
          <Input type="email" value={form.email} onChange={set('email')} maxLength={254} autoComplete="off" data-testid="account-email" />
        </Field>
      </div>
      <InlineError error={error} className="mt-2" />
    </KitModal>
  )
}
