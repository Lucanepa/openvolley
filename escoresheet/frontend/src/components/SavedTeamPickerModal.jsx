import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import KitModal from './manage/KitModal'
import { useSavedTeams } from '../hooks/useSavedTeams'
import { normalizeName, rosterHasContent } from '../domain/savedTeams'
import { Select, SearchInput, RowList, Row, Chip, EmptyInset, SkeletonRows, Banner, dayTimeLabel, confirmDialog } from '../ui'

/**
 * Ask before a saved team replaces a roster that already holds players or
 * team officials. Resolves true when the load may go ahead.
 */
export async function confirmReplaceRoster({ roster, bench, teamLabel, t }) {
  if (!rosterHasContent(roster, bench)) return true
  return confirmDialog({
    title: t('savedTeams.replaceConfirmTitle'),
    message: t('savedTeams.replaceConfirmBody', { team: teamLabel || '' }),
    confirmLabel: t('savedTeams.replace'),
    cancelLabel: t('common.cancel', 'Cancel'),
    tone: 'danger'
  })
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * "Load saved team": pick a saved team from the offline cache. The cache is
 * refreshed when the picker opens (online); offline it shows the cached
 * teams with their date.
 */
export default function SavedTeamPickerModal({ open, onClose, onPick, userId, access, defaultCompetitionId = '', title, roster, bench, teamLabel }) {
  const { t } = useTranslation()
  if (!open) return null
  return <PickerBody {...{ onClose, onPick, userId, access, defaultCompetitionId, title, roster, bench, teamLabel, t }} />
}

function PickerBody({ onClose, onPick, userId, access, defaultCompetitionId, title, roster, bench, teamLabel, t }) {
  const { teams, competitions, meta, loading } = useSavedTeams({ userId, access, refreshOnMount: true })
  const [competitionId, setCompetitionId] = useState(defaultCompetitionId || '')
  const [q, setQ] = useState('')
  const online = isOnline()

  const visibleCompetitions = useMemo(
    () => competitions.filter(c => !c.archived).sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name)),
    [competitions]
  )
  const list = useMemo(() => {
    const needle = normalizeName(q)
    return teams
      .filter(team => !team.competition?.archived)
      .filter(team => !competitionId || team.competitionId === competitionId)
      .filter(team => !needle || normalizeName(`${team.name} ${team.club} ${team.svrzTeamName}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [teams, competitionId, q])

  return (
    <KitModal
      open
      onClose={onClose}
      layout="sections"
      size="lg"
      title={title || t('savedTeams.pickerTitle')}
      icon={Users}
      closeLabel={t('common.close', 'Close')}
    >
      {!online && meta?.fetchedAt && (
        <Banner tone="info" data-testid="saved-teams-offline">
          {t('savedTeams.pickerOffline', { date: dayTimeLabel(meta.fetchedAt) })}
        </Banner>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          aria-label={t('savedTeams.pickerCompetition')}
          value={competitionId}
          onChange={e => setCompetitionId(e.target.value)}
          className="sm:w-64"
        >
          <option value="">{t('savedTeams.pickerAll')}</option>
          {visibleCompetitions.map(c => <option key={c.id} value={c.id}>{c.name} · {c.season}</option>)}
        </Select>
        <SearchInput size="md" value={q} onChange={e => setQ(e.target.value)} placeholder={t('savedTeams.pickerSearch')} aria-label={t('savedTeams.pickerSearch')} />
      </div>
      {loading && !teams.length ? (
        <SkeletonRows rows={4} pill={false} />
      ) : list.length === 0 ? (
        <EmptyInset>{t('savedTeams.pickerEmpty')}</EmptyInset>
      ) : (
        <RowList>
          {list.map(team => {
            const active = (team.players || []).filter(p => p.active !== false).length
            return (
              <Row
                key={team.id}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={team.name}
                meta={<>
                  {team.club && <span>{team.club}</span>}
                  {team.competition && <span>{team.competition.name} · {team.competition.season}</span>}
                </>}
                status={<Chip>{t('savedTeams.pickerPlayers', { count: active })}</Chip>}
                onOpen={async () => {
                  if (await confirmReplaceRoster({ roster, bench, teamLabel, t })) onPick(team)
                }}
                label={team.name}
                data-testid="saved-team-row"
              />
            )
          })}
        </RowList>
      )}
    </KitModal>
  )
}
