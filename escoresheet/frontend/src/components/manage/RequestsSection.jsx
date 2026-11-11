import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clubApi, teamApi } from '../../lib/accountApi'
import { requestPartLabel, sortRequestParts } from '../../domain/signUpRequests'
import { usePanelData, useOnline, PanelHead, InlineError, useErrorText } from './common'
import { Chip, EmptyInset, Notice, Row, RowList, RowTool, confirmDialog, dayLabel, toast } from '../../ui'

/**
 * Sign-up requests one approver decides (db/025, docs/account-approval-spec.md
 * section 8): in My club the parts of the club (scorer, team manager of one of
 * its teams, club manager), in My teams the team manager parts of the team.
 * One row per part: Approve grants exactly that (the role and the club, the
 * team, the club to manage), Reject drops it; the account's other parts stay
 * for the other approvers. The server decides who may decide which part.
 *
 * `club` or `team` (one of them): { id, name }.
 */
export default function RequestsSection({ club = null, team = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const scopeId = club?.id || team?.id
  const api = club
    ? { list: () => clubApi.requests(club.id), decide: (userId, body) => clubApi.decideRequests(club.id, userId, body) }
    : { list: () => teamApi.requests(team.id), decide: (userId, body) => teamApi.decideRequests(team.id, userId, body) }
  const { data, error, reload } = usePanelData(api.list, [scopeId], { enabled: online })
  const [busy, setBusy] = useState(null) // part id
  const [rowError, setRowError] = useState({})
  // An older server without db/025 answers 404: no section at all. So
  // nothing until the first answer either (not a skeleton that then goes)
  if (error?.status === 404 || error?.code === 'OV_NOT_FOUND') return null
  if (!data && !error) return null
  const rows = (data?.requests || []).flatMap((r) => sortRequestParts(r.parts).map((part) => ({ user: r.user, part })))

  const decide = async ({ user, part }, approve) => {
    const name = user.name || user.email
    if (!approve) {
      const ok = await confirmDialog({
        title: t('manage.requests.rejectTitle', { name }),
        message: t('manage.requests.rejectBody', { part: requestPartLabel(part, t) }),
        confirmLabel: t('manage.requests.reject'),
        cancelLabel: t('common.cancel', 'Cancel'),
        tone: 'danger'
      })
      if (!ok) return
    }
    setBusy(part.id)
    setRowError((e) => ({ ...e, [part.id]: '' }))
    const res = await api.decide(user.id, approve ? { approve: [{ id: part.id }] } : { reject: [part.id] })
    setBusy(null)
    if (res.error) {
      if (res.error.code === 'OV_REQUEST_GONE') {
        toast.info(t('manage.requests.gone'))
        reload({ quiet: true })
        return
      }
      setRowError((e) => ({ ...e, [part.id]: res.error.code === 'OV_EMAIL_UNCONFIRMED' ? t('manage.accounts.confirmEmailFirst') : errorText(res.error) }))
      return
    }
    toast.success(t(approve ? 'manage.requests.approved' : 'manage.requests.rejected'))
    reload({ quiet: true })
  }

  return (
    <section data-testid={club ? 'club-requests' : 'team-requests'}>
      <PanelHead title={t('manage.requests.title')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t(club ? 'manage.requests.clubHint' : 'manage.requests.teamHint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : rows.length === 0 ? (
        <EmptyInset>{t('manage.requests.empty')}</EmptyInset>
      ) : (
        <RowList>
          {rows.map(({ user, part }) => (
            <Row
              key={part.id}
              data-testid={`request-${part.id}`}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={user.name || user.email}
              meta={<>
                {user.name && <span className="min-w-0 max-w-full truncate" title={user.email}>{user.email}</span>}
                {user.created_at && <span>{t('manage.requests.signedUp', { date: dayLabel(user.created_at, { year: true }) })}</span>}
                {user.email_confirmed === false && <span className="font-medium text-amber-700">{t('manage.accounts.emailUnconfirmed')}</span>}
              </>}
              chips={<Chip tone="amber">{requestPartLabel(part, t)}</Chip>}
              tools={<>
                <RowTool primary disabled={!online || busy === part.id} onClick={() => decide({ user, part }, true)}>{t('manage.requests.approve')}</RowTool>
                <RowTool disabled={!online || busy === part.id} onClick={() => decide({ user, part }, false)}>{t('manage.requests.reject')}</RowTool>
                <InlineError error={rowError[part.id]} className="ml-1" />
              </>}
            />
          ))}
        </RowList>
      )}
    </section>
  )
}
