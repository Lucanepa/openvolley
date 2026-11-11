import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clubApi } from '../../lib/accountApi'
import InvitesPanel from './InvitesPanel'
import ClubTeamsSection from './ClubTeamsSection'
import ClubLicencesSection from './ClubLicencesSection'
import RequestsSection from './RequestsSection'
import ClubPersonPage from './ClubPersonPage'
import { usePanelData, usePanelRoute, useOnline, OfflineBanner, PageLoadGate, PanelHead, InlineError, useErrorText } from './common'
import { Button, Chip, EmptyInset, Field, Input, Notice, Row, RowList, RowTool, Select, SkeletonRows, confirmDialog, dayLabel, toast } from '../../ui'

/**
 * My club (db/020, lib/clubs.js): what a club manager does for its own
 * club(s): the contact address that gets the final scoresheets, the accounts
 * that score for the club, its teams, its licence lists from VolleyManager
 * (db/024), the sign-up requests of the club (db/025: approve or reject who
 * says they score, manage a team or manage the club), and the club's invite
 * codes. Taking someone off the
 * club removes the club link only: the account and its roles stay. An account
 * that manages several clubs picks one first.
 *
 * Pages (owner 2026-11-10: "every page there gets their own page (team,
 * club, game, player etc)"): the club at #myclub/<club id>, a person of its
 * licence lists at #myclub/<club id>/person/<licence number>; a team opens
 * in My teams (`navigate`, when this account has that tab).
 */
export default function MyClubPanel({ clubs = [], route = '', onRoute = null, navigate = null, canOpen = () => false }) {
  const { t } = useTranslation()
  const [[routeClub, kind, key], go] = usePanelRoute(route, onRoute)
  const club = clubs.find((c) => c.id === routeClub) || clubs[0]
  if (!club) return <EmptyInset>{t('manage.myClub.none')}</EmptyInset>
  const openTeam = navigate && canOpen('myteams') ? (teamId) => navigate(`myteams/${encodeURIComponent(teamId)}`) : null
  if (kind === 'person' && key) {
    return <ClubPersonPage key={`${club.id}/${key}`} club={club} svNumber={key} onBack={() => go([club.id])} onOpenTeam={openTeam} />
  }
  return (
    <div className="space-y-8" data-testid="manage-my-club">
      {clubs.length > 1 && (
        <Field label={t('manage.myClub.pick')}>
          <Select value={club.id} onChange={(e) => go([e.target.value])} data-testid="my-club-pick">
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      )}
      {/* keyed: another club starts its sections afresh, and appears whole
          (contact, requests, members, teams, licences, codes) */}
      <PageLoadGate key={club.id} className="space-y-8" fallback={<SkeletonRows rows={6} pill={false} />}>
        <ClubSections club={club} onOpenPerson={(sv) => go([club.id, 'person', sv])} onOpenTeam={openTeam} />
      </PageLoadGate>
    </div>
  )
}

function ClubSections({ club, onOpenPerson, onOpenTeam }) {
  const { t } = useTranslation()
  return (
    <>
      <ClubContact clubId={club.id} />
      {/* db/025: who signed up for this club and waits for a yes */}
      <RequestsSection club={club} />
      <ClubMembers club={club} />
      {/* db/023: the club's teams and their team links */}
      <ClubTeamsSection club={club} onOpenTeam={onOpenTeam} />
      {/* db/024: the club's licence lists from VolleyManager */}
      <ClubLicencesSection club={club} onOpenPerson={onOpenPerson} />
      <InvitesPanel club={club} title={t('manage.myClub.invites')} />
    </>
  )
}

function ClubContact({ clubId }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubApi.get(clubId), [clubId], { enabled: online })
  const club = data?.club
  const [value, setValue] = useState(null) // null: not edited yet
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const shown = value ?? club?.contact_email ?? ''
  const save = async (e) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setSaveError('')
    const res = await clubApi.setContact(clubId, shown.trim())
    setBusy(false)
    if (res.error) {
      setSaveError(errorText(res.error))
      return
    }
    setValue(null)
    toast.success(t('manage.myClub.contactSaved'))
    reload()
  }
  return (
    <section>
      <PanelHead title={club?.name || t('manage.tabs.myclub')} />
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : loading && !data ? <SkeletonRows rows={1} pill={false} /> : club && (
        <div className="space-y-3">
          {club.teams.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{club.teams.map((n) => <Chip key={n}>{n}</Chip>)}</div>
          )}
          <form onSubmit={save}>
            {/* the hint under the row, so Save lines up with the field */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label={t('manage.clubs.contact')} className="flex-1">
                <Input type="email" value={shown} onChange={(e) => setValue(e.target.value)} maxLength={254} data-testid="my-club-contact" />
              </Field>
              <Button type="submit" variant="secondary" disabled={!online || busy || value === null} loading={busy} data-testid="my-club-contact-save">
                {t('manage.myClub.save')}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-stone-500">{t('manage.clubs.contactHint')}</p>
          </form>
          <InlineError error={saveError} />
        </div>
      )}
    </section>
  )
}

function ClubMembers({ club }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubApi.members(club.id), [club.id], { enabled: online })
  const members = data?.members || []
  const [rowError, setRowError] = useState({})
  const remove = async (m) => {
    const ok = await confirmDialog({
      title: t('manage.myClub.removeTitle', { name: m.name || m.email }),
      message: t('manage.myClub.removeBody', { club: club.name }),
      confirmLabel: t('manage.myClub.remove'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await clubApi.removeMember(club.id, m.id)
    if (res.error) {
      setRowError((e) => ({ ...e, [m.id]: errorText(res.error) }))
      return
    }
    toast.success(t('manage.myClub.removed'))
    reload()
  }
  return (
    <section>
      <PanelHead title={t('manage.myClub.members')} level={2} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : loading && !data ? (
        <SkeletonRows rows={3} pill={false} />
      ) : members.length === 0 ? (
        <EmptyInset>{t('manage.myClub.noMembers')}</EmptyInset>
      ) : (
        <RowList data-testid="my-club-members">
          {members.map((m) => (
            <Row
              key={m.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={m.name || m.email}
              meta={<>
                {m.name && <span className="min-w-0 max-w-full truncate" title={m.email}>{m.email}</span>}
                {m.joined_at && <span>{t('manage.myClub.joined')} {dayLabel(m.joined_at, { year: true })}</span>}
              </>}
              chips={<>
                {m.manager && <Chip tone="amber">{t('manage.myClub.manager')}</Chip>}
                {m.roles.length
                  ? m.roles.map((r) => <Chip key={r} tone="indigo">{t(`access.roles.${r}`, r)}</Chip>)
                  : <Chip>{t('manage.myClub.pending')}</Chip>}
              </>}
              tools={<>
                <RowTool disabled={!online} onClick={() => remove(m)}>{t('manage.myClub.remove')}</RowTool>
                <InlineError error={rowError[m.id]} className="ml-1" />
              </>}
            />
          ))}
        </RowList>
      )}
    </section>
  )
}
