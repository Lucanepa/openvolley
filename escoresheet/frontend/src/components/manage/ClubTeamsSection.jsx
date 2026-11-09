import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Link2, Share2 } from 'lucide-react'
import { clubApi } from '../../lib/accountApi'
import { teamLinkUrl } from '../../utils/managerSite'
import KitModal from './KitModal'
import { usePanelData, useOnline, PanelHead, InlineError, useErrorText } from './common'
import { Button, Chip, EmptyInset, Notice, Row, RowList, RowTool, SkeletonRows, confirmDialog, dayLabel, toast } from '../../ui'

/**
 * My club → Teams (db/023, docs/team-managers-spec.md section 2): the club's
 * teams with their team managers. "Create link" makes a team link (an invite
 * code for that team, 3 uses, 30 days) to hand to the team's coach or
 * manager; it is shown once. Taking a team manager off removes the team only.
 */
export default function ClubTeamsSection({ club }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubApi.teams(club.id), [club.id], { enabled: online })
  const teams = data?.teams || []
  const [busy, setBusy] = useState(null) // team id
  const [rowError, setRowError] = useState({})
  const [created, setCreated] = useState(null) // { team, url, invite }

  const createLink = async (team) => {
    if (busy) return
    setBusy(team.id)
    setRowError((e) => ({ ...e, [team.id]: '' }))
    const res = await clubApi.createTeamLink(club.id, team.id)
    setBusy(null)
    if (res.error) {
      setRowError((e) => ({ ...e, [team.id]: errorText(res.error) }))
      return
    }
    setCreated({ team, url: teamLinkUrl(res.data.code), invite: res.data.invite })
    reload({ quiet: true })
  }
  const removeManager = async (team, m) => {
    const ok = await confirmDialog({
      title: t('manage.clubTeams.removeTitle', { name: m.name || m.email }),
      message: t('manage.clubTeams.removeBody', { team: team.name }),
      confirmLabel: t('manage.myClub.remove'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await clubApi.removeTeamManager(club.id, team.id, m.user_id)
    if (res.error) {
      setRowError((e) => ({ ...e, [team.id]: errorText(res.error) }))
      return
    }
    toast.success(t('manage.myClub.removed'))
    reload()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created?.url || '')
      toast.success(t('manage.invites.copied'))
    } catch { /* no clipboard: the link stays selectable */ }
  }
  const share = async () => {
    try {
      await navigator.share({ title: t('manage.clubTeams.shareTitle', { team: created?.team?.name || '' }), text: t('manage.clubTeams.shareText', { team: created?.team?.name || '' }), url: created?.url })
    } catch { /* cancelled, or no share sheet: Copy is there */ }
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return (
    <section>
      <PanelHead title={t('manage.clubTeams.title')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t('manage.clubTeams.hint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={2} pill={false} />
      ) : teams.length === 0 ? (
        <EmptyInset>{t('manage.clubTeams.none')}</EmptyInset>
      ) : (
        <RowList data-testid="club-teams">
          {teams.map((team) => (
            <Row
              key={team.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={team.name}
              meta={team.open_links > 0 ? <span>{t('manage.clubTeams.openLinks', { count: team.open_links })}</span> : null}
              chips={team.managers.length
                ? team.managers.map((m) => (
                  <Chip key={m.user_id} tone="indigo">
                    {m.name || m.email}
                    <button type="button" className="ml-1 text-indigo-500 hover:text-indigo-900 disabled:opacity-50" disabled={!online} onClick={() => removeManager(team, m)} aria-label={t('manage.clubTeams.removeTitle', { name: m.name || m.email })}>×</button>
                  </Chip>
                ))
                : <Chip>{t('manage.clubTeams.noManager')}</Chip>}
              tools={<>
                <RowTool disabled={!online || busy === team.id} onClick={() => createLink(team)} data-testid="club-team-link">
                  <Link2 size={14} aria-hidden className="mr-1 inline" />{t('manage.clubTeams.createLink')}
                </RowTool>
                <InlineError error={rowError[team.id]} className="ml-1" />
              </>}
            />
          ))}
        </RowList>
      )}
      <KitModal
        open={!!created}
        onClose={() => setCreated(null)}
        title={t('manage.clubTeams.linkTitle', { team: created?.team?.name || '' })}
        closeLabel={t('common.close', 'Close')}
        footer={<Button variant="secondary" size="lg" onClick={() => setCreated(null)}>{t('common.close', 'Close')}</Button>}
      >
        <div className="space-y-3" data-testid="team-link-created">
          <p className="text-sm text-stone-600">{t('manage.clubTeams.linkBody')}</p>
          <output className="block break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-xs text-stone-800" data-testid="team-link-url">{created?.url}</output>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Copy} onClick={copy}>{t('manage.clubTeams.copyLink')}</Button>
            {canShare && <Button variant="secondary" icon={Share2} onClick={share}>{t('manage.clubTeams.share')}</Button>}
          </div>
          <p className="text-xs text-stone-500">
            {t('manage.clubTeams.linkLimits', {
              uses: created?.invite?.max_uses ?? '',
              date: created?.invite?.expires_at ? dayLabel(created.invite.expires_at, { year: true }) : ''
            })}
          </p>
        </div>
      </KitModal>
    </section>
  )
}
