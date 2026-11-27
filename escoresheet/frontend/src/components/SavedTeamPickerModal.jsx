import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import KitModal from './manage/KitModal'
import { useSavedTeams } from '../hooks/useSavedTeams'
import { normalizeName, rosterHasContent, savedTeamOfClub, savedTeamsOfClub } from '../domain/savedTeams'
import { Select, SearchInput, RowList, Row, Chip, EmptyInset, SkeletonRows, Banner, dayTimeLabel, confirmDialog } from '../ui'
import { cn } from '../ui/cn.js'
import { FOCUS_RING } from '../ui/Button.jsx'
import { PICKER_RESULTS } from './pickerLayout'

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
 * `club` ({ id, name }, domain/savedTeams clubOfMatchTeam): only the saved
 * teams of the club of the team being edited (owner 2026-11-27), matched by
 * id through `clubIdOf`, else by the club's name; null (not known): all.
 * "Show all saved teams" (owner 27.11.2026) lists every one, the other
 * clubs' teams marked as such.
 */
export default function SavedTeamPickerModal({ open, onClose, onPick, userId, access, defaultCompetitionId = '', title, roster, bench, teamLabel, club = null, clubIdOf }) {
  const { t } = useTranslation()
  if (!open) return null
  return <PickerBody {...{ onClose, onPick, userId, access, defaultCompetitionId, title, roster, bench, teamLabel, club, clubIdOf, t }} />
}

function PickerBody({ onClose, onPick, userId, access, defaultCompetitionId, title, roster, bench, teamLabel, club, clubIdOf, t }) {
  const { teams, competitions, meta, loading } = useSavedTeams({ userId, access, refreshOnMount: true })
  const [competitionId, setCompetitionId] = useState(defaultCompetitionId || '')
  const [q, setQ] = useState('')
  // every club's teams, on request (the other clubs' marked)
  const [allClubs, setAllClubs] = useState(false)
  const online = isOnline()

  const visibleCompetitions = useMemo(
    () => competitions.filter(c => !c.archived).sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name)),
    [competitions]
  )
  const current = useMemo(() => teams.filter(team => !team.competition?.archived), [teams])
  const ofClub = useMemo(() => savedTeamsOfClub(current, club, clubIdOf), [current, club, clubIdOf])
  const filtered = !!club && !allClubs
  const otherClubs = club ? current.length - ofClub.length : 0
  const isOtherClub = (team) => !!club && allClubs && !savedTeamOfClub(team, club, clubIdOf)
  const list = useMemo(() => {
    const needle = normalizeName(q)
    return (filtered ? ofClub : current)
      .filter(team => !competitionId || team.competitionId === competitionId)
      .filter(team => !needle || normalizeName(`${team.name} ${team.club} ${team.svrzTeamName}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [filtered, ofClub, current, competitionId, q])

  return (
    <KitModal
      open
      onClose={onClose}
      layout="sections"
      size="lg"
      title={title || t('savedTeams.pickerTitle')}
      description={club?.name ? (allClubs ? t('savedTeams.pickerAllClubs') : t('savedTeams.pickerClubOnly', { club: club.name })) : undefined}
      icon={Users}
      closeLabel={t('common.close', 'Close')}
    >
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
      {/* the club's teams only, or every club's on request (one line, the same in both states) */}
      {club && (otherClubs > 0 || allClubs) && (
        <button
          type="button"
          onClick={() => setAllClubs((v) => !v)}
          className={cn('self-start text-sm font-medium text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-stone-900', FOCUS_RING)}
          data-testid={allClubs ? 'saved-teams-only-club' : 'saved-teams-show-all'}
        >
          {allClubs ? t('savedTeams.pickerOnlyClub', { club: club.name }) : t('savedTeams.pickerShowAll', { count: otherClubs })}
        </button>
      )}
      {/* Fixed-height result area (pickerLayout.js): the skeleton, the empty
          message and the list fill the same box, and the offline note (known
          only once the cache is read) sits inside it, so the dialog does not
          resize when the teams arrive or the search narrows them. */}
      <div data-testid="saved-team-results" className={cn(PICKER_RESULTS, 'space-y-3')}>
        {!online && meta?.fetchedAt && (
          <Banner tone="info" data-testid="saved-teams-offline">
            {t('savedTeams.pickerOffline', { date: dayTimeLabel(meta.fetchedAt) })}
          </Banner>
        )}
        {loading && !teams.length ? (
          <SkeletonRows rows={4} pill={false} />
        ) : filtered && current.length > 0 && ofClub.length === 0 ? (
          // none of the club: said in one line, never an empty list
          <div data-testid="saved-teams-none-of-club">
            <EmptyInset>{club.name ? t('savedTeams.pickerNoneOfClub', { club: club.name }) : t('savedTeams.pickerNoneOfTheClub')}</EmptyInset>
          </div>
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
                  status={<span className="flex flex-wrap justify-end gap-1">
                    {isOtherClub(team) && <span data-testid="saved-team-other-club"><Chip tone="amber">{t('savedTeams.pickerOtherClub')}</Chip></span>}
                    <Chip>{t('savedTeams.pickerPlayers', { count: active })}</Chip>
                  </span>}
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
      </div>
    </KitModal>
  )
}
