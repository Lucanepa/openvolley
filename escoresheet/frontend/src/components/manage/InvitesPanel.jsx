import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Plus } from 'lucide-react'
import { teamLinkUrl } from '../../utils/managerSite'
import { admin, clubApi, clubsApi } from '../../lib/accountApi'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, DateField, Field, Input, Select, RowList, Row, RowTool, Chip, StatusPill, EmptyInset, SkeletonRows, Notice, ModalStrip, dayLabel, confirmDialog, toast } from '../../ui'

const STATE_TONE = { active: 'done', expired: 'neutral', used_up: 'neutral', revoked: 'brand' }
const INVITE_ROLES = ['scorer', 'referee', 'competition_manager']
// db/023: an admin's team link for any club's team (owner 2026-11-11: "as admin
// I can create a link for everything"), within lib/teams.js teamInviteBody's limits
const TEAM_ROLE = 'team_manager'
const TEAM_MAX_USES = 10
const TEAM_MAX_DAYS = 90
// db/020: a club manager's codes (lib/clubs.js clubInviteBody): scorer or
// referee, at most 50 uses, gone after 90 days at most
const CLUB_INVITE_ROLES = ['scorer', 'referee']
const CLUB_MAX_USES = 50
const CLUB_MAX_DAYS = 90

function plusDays(days) {
  const d = new Date(Date.now() + days * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Invite codes: create (shown once), list, revoke (admins). `app` 'indoor' /
 * 'beach' (OpenVolley's / OpenBeach's console): that app's codes only, and
 * new codes are of that sport (beach: they grant the beach role). Left out:
 * every code, new codes indoor (as before).
 * `club` { id, name } (db/020, the My club tab): that club's codes only, made
 * for it within a club manager's limits (the server checks them again).
 * An admin's console also makes team links (db/023, role Team manager): the
 * club and one of its teams, at most 10 uses and 90 days; the link is shown
 * once, like a code.
 */
export default function InvitesPanel({ app, club = null, title }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null) // { code, invite } — shown once
  const [rowError, setRowError] = useState({})
  const clubId = club?.id || null
  const { data, error, loading, reload } = usePanelData(
    () => (clubId ? clubApi.listInvites(clubId) : app ? admin.listInvites({ app }) : admin.listInvites()),
    [app, clubId], { enabled: online })
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
    const res = clubId ? await clubApi.revokeInvite(clubId, invite.id) : await admin.revokeInvite(invite.id)
    if (res.error) {
      setRowError(e => ({ ...e, [invite.id]: errorText(res.error) }))
      return
    }
    reload()
  }

  return (
    <section>
      <PanelHead title={title || t('manage.tabs.invites')} level={club ? 2 : 1}>
        <Button icon={Plus} onClick={() => setCreating(true)} disabled={!online}>{t('manage.invites.new')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : loading && !data ? (
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
                {/* db/023: a team link names its team */}
                {inv.team_name && <Chip>{inv.team_name}</Chip>}
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
        club={club}
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
          {created?.url ? (
            <output data-testid="invite-link" className="flex-1 select-all break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-medium text-stone-900">
              {created.url}
            </output>
          ) : (
            <output data-testid="invite-code" className="flex-1 select-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-center font-mono text-lg font-bold tracking-[0.3em] text-stone-900">
              {created?.code}
            </output>
          )}
          <Button
            variant="secondary"
            icon={Copy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created?.url || created?.code || '')
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

function CreateInviteModal({ app, club: fixedClub = null, open, onClose, onCreated }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [label, setLabel] = useState('')
  const [club, setClub] = useState('')
  // db/018: the club whoever redeems the code joins (OpenVolley); a club
  // manager's code is always its club's (no choice, no admin club list)
  const withClubs = app !== 'beach' && !fixedClub
  const roles = fixedClub ? CLUB_INVITE_ROLES : INVITE_ROLES
  const maxUsesCap = fixedClub ? CLUB_MAX_USES : 10000
  const [clubId, setClubId] = useState('')
  const clubList = usePanelData(() => (withClubs && open ? clubsApi.list() : Promise.resolve({ data: null })), [withClubs, open])
  const clubs = clubList.data?.clubs || []
  const [role, setRole] = useState('scorer')
  // an admin's team link: OpenVolley's console only, needs a club and one of its teams
  const withTeams = withClubs && app !== 'beach'
  const teamLink = withTeams && role === TEAM_ROLE
  const [teamId, setTeamId] = useState('')
  const teamList = usePanelData(() => (teamLink && clubId ? clubApi.teams(clubId) : Promise.resolve({ data: null })), [teamLink, clubId])
  const teams = [...(teamList.data?.teams || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const [maxUses, setMaxUses] = useState('1')
  const [expires, setExpires] = useState(plusDays(30))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => { setLabel(''); setClub(''); setClubId(''); setRole('scorer'); setTeamId(''); setMaxUses('1'); setExpires(plusDays(30)); setError('') }
  const usesCap = teamLink ? TEAM_MAX_USES : maxUsesCap
  const maxValid = (maxUses === '' && !fixedClub && !teamLink) || (/^\d+$/.test(maxUses) && Number(maxUses) >= 1 && Number(maxUses) <= usesCap)
  // a team link has no label (it names its team) and always an end, 90 days at most
  const valid = teamLink
    ? !!clubId && !!teamId && maxValid && !!expires && expires <= plusDays(TEAM_MAX_DAYS)
    : label.trim().length >= 1 && maxValid && (!fixedClub || !!expires)
  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    // Expiry at the end of the chosen day (Zurich local time of this device)
    const expiresAt = expires ? new Date(`${expires}T23:59:59`).toISOString() : null
    if (teamLink) {
      const r = await clubApi.createTeamLink(clubId, teamId, { max_uses: Number(maxUses), expires_at: expiresAt })
      setBusy(false)
      if (r.error || !r.data?.code) {
        setError(errorText(r.error || { status: 500 }))
        return
      }
      const team = teams.find((x) => x.id === teamId)
      const clubName = clubs.find((c) => c.id === clubId)?.name || ''
      reset()
      onCreated({ ...r.data, url: teamLinkUrl(r.data.code), invite: { ...(r.data.invite || {}), label: team?.name || '', club: clubName, role: TEAM_ROLE } })
      return
    }
    const res = fixedClub ? await clubApi.createInvite(fixedClub.id, {
      label: label.trim(),
      role,
      max_uses: Number(maxUses),
      expires_at: expiresAt
    }) : await admin.createInvite({
      label: label.trim(),
      club: clubId ? null : (club.trim() || null),
      ...(clubId ? { club_id: clubId } : {}),
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
        {!teamLink && (
          <Field label={t('manage.invites.label')} hint={t('manage.invites.labelHint')}>
            <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} required autoFocus />
          </Field>
        )}
        {fixedClub ? (
          <Field label={t('manage.invites.club')}>
            <Input value={fixedClub.name} readOnly disabled data-testid="invite-fixed-club" />
          </Field>
        ) : withClubs && clubs.length > 0 ? (
          <Field label={t('manage.invites.club')} hint={t('manage.invites.clubHint')}>
            <Select value={clubId} onChange={e => { setClubId(e.target.value); setTeamId('') }} data-testid="invite-club">
              <option value="">{teamLink ? t('manage.invites.pickClub') : t('manage.invites.noClub')}</option>
              {clubs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label={t('manage.invites.club')}>
            <Input value={club} onChange={e => setClub(e.target.value)} maxLength={120} />
          </Field>
        )}
        <Field label={t('manage.invites.role')} hint={teamLink ? t('manage.invites.teamLinkHint') : undefined}>
          <Select value={role} onChange={e => { const r = e.target.value; setRole(r); if (r === TEAM_ROLE) { setMaxUses('3'); if (expires > plusDays(TEAM_MAX_DAYS)) setExpires(plusDays(30)) } }} data-testid="invite-role">
            {roles.map(r => <option key={r} value={r}>{t(`access.roles.${r}`)}</option>)}
            {withTeams && <option value={TEAM_ROLE}>{t('access.roles.team_manager')}</option>}
          </Select>
        </Field>
        {teamLink && (
          <Field label={t('manage.invites.team')}>
            <Select value={teamId} onChange={e => setTeamId(e.target.value)} disabled={!clubId || (teamList.loading && !teamList.data)} data-testid="invite-team">
              <option value="">{clubId ? t('manage.invites.pickTeam') : t('manage.invites.clubFirst')}</option>
              {teams.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        )}
        {teamLink && clubId && teamList.data && teams.length === 0 && <Notice tone="warning">{t('manage.invites.noTeams')}</Notice>}
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <Field label={t('manage.invites.maxUses')} hint={fixedClub ? t('manage.myClub.maxUsesHint', { max: CLUB_MAX_USES }) : teamLink ? t('manage.myClub.maxUsesHint', { max: TEAM_MAX_USES }) : t('manage.invites.maxUsesHint')}>
            <Input type="number" inputMode="numeric" min={1} max={usesCap} value={maxUses} onChange={e => setMaxUses(e.target.value)} data-testid="invite-max-uses" />
          </Field>
          <Field label={t('manage.invites.expires')} hint={fixedClub ? t('manage.myClub.expiresHint', { days: CLUB_MAX_DAYS }) : teamLink ? t('manage.myClub.expiresHint', { days: TEAM_MAX_DAYS }) : undefined}>
            <DateField value={expires} onChange={setExpires} max={fixedClub ? plusDays(CLUB_MAX_DAYS) : teamLink ? plusDays(TEAM_MAX_DAYS) : undefined} />
          </Field>
        </div>
        <InlineError error={error} />
        <button type="submit" hidden />
      </form>
    </KitModal>
  )
}
