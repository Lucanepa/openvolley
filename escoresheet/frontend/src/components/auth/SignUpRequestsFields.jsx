import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Checkbox, Chip, Field, FOCUS_RING, Select, cn } from '../../ui'

/**
 * "What do you do?" on OpenVolley's sign-up (db/025): scorer (of one or more
 * clubs), referee (no club), team manager / coach (a club, then its teams),
 * club manager (a club). Optional: with nothing ticked the account is pending
 * as before. The clubs and teams come from GET /api/public/clubs (ids and
 * names only). Competition manager is not on the list (an admin gives it).
 *
 * @param {object} props
 * @param {object} props.value  the choice (domain/signUpRequests emptyRequestChoice shape)
 * @param {(next: object) => void} props.onChange
 * @param {Array<{ id: string, name: string, teams: Array<{ id: string, name: string }> }> | null} props.clubs
 *   null while loading
 * @param {boolean} [props.clubsFailed] the list could not be loaded (offline, an old server)
 * @param {{ kind: string, key: string } | null} [props.problem] what is missing (shown at its kind)
 */
export default function SignUpRequestsFields({ value, onChange, clubs, clubsFailed = false, problem = null }) {
  const { t } = useTranslation()
  const list = clubs || []
  const noClubs = list.length === 0
  const set = (kind, patch) => onChange({ ...value, [kind]: { ...value[kind], ...patch } })
  const clubName = (id) => list.find((c) => c.id === id)?.name || ''
  const error = (kind) => (problem?.kind === kind ? t(problem.key) : '')
  const clubOptions = (exclude = []) => list.filter((c) => !exclude.includes(c.id)).map((c) => ({ value: c.id, label: c.name }))
  const tmClub = list.find((c) => c.id === value.team_manager.clubId) || null

  return (
    <fieldset className="space-y-2.5 rounded-xl border border-stone-200 p-3" data-testid="signup-requests">
      <legend className="px-1 text-sm font-medium text-stone-700">{t('access.requests.whatDoYouDo')}</legend>
      <p className="text-xs text-stone-500">{t('access.requests.whatHint')}</p>
      {clubsFailed && <p role="status" className="text-xs text-amber-700" data-testid="signup-clubs-failed">{t('access.requests.clubsUnavailable')}</p>}
      {!clubsFailed && clubs && noClubs && <p className="text-xs text-stone-500">{t('access.requests.noClubsYet')}</p>}

      {/* Scorer: one or more clubs */}
      <div>
        <Checkbox
          label={t('access.requests.kinds.scorer')}
          hint={t('access.requests.scorerHint')}
          checked={value.scorer.on}
          disabled={noClubs && !value.scorer.on}
          onChange={(e) => set('scorer', { on: e.target.checked })}
          data-testid="signup-request-scorer"
        />
        {value.scorer.on && (
          <div className="mt-2 space-y-2 pl-7">
            {value.scorer.clubIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {value.scorer.clubIds.map((id) => (
                  <Chip key={id} tone="sky" className="gap-1 pr-1">
                    {clubName(id)}
                    <button
                      type="button"
                      onClick={() => set('scorer', { clubIds: value.scorer.clubIds.filter((x) => x !== id) })}
                      aria-label={t('access.requests.removeClub', { name: clubName(id) })}
                      className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-sky-700 hover:bg-sky-100', FOCUS_RING)}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </Chip>
                ))}
              </div>
            )}
            {clubOptions(value.scorer.clubIds).length > 0 && (
              <Field label={value.scorer.clubIds.length ? t('access.requests.addClub') : t('access.requests.scorerClub')} error={error('scorer')}>
                <Select
                  size="lg"
                  block
                  value=""
                  placeholder={t('access.requests.pickClub')}
                  options={clubOptions(value.scorer.clubIds)}
                  onChange={(e) => { if (e.target.value) set('scorer', { clubIds: [...value.scorer.clubIds, e.target.value] }) }}
                  data-testid="signup-scorer-club"
                />
              </Field>
            )}
          </div>
        )}
      </div>

      {/* Referee: no club */}
      <Checkbox
        label={t('access.requests.kinds.referee')}
        hint={t('access.requests.refereeHint')}
        checked={value.referee.on}
        onChange={(e) => set('referee', { on: e.target.checked })}
        data-testid="signup-request-referee"
      />

      {/* Team manager / coach: a club, then its teams */}
      <div>
        <Checkbox
          label={t('access.requests.kinds.team_manager')}
          hint={t('access.requests.teamManagerHint')}
          checked={value.team_manager.on}
          disabled={noClubs && !value.team_manager.on}
          onChange={(e) => set('team_manager', { on: e.target.checked })}
          data-testid="signup-request-team_manager"
        />
        {value.team_manager.on && (
          <div className="mt-2 space-y-2 pl-7">
            <Field label={t('access.requests.teamClub')} error={problem?.key === 'access.requests.needTeamClub' ? error('team_manager') : ''}>
              <Select
                size="lg"
                block
                value={value.team_manager.clubId}
                placeholder={t('access.requests.pickClub')}
                options={clubOptions()}
                onChange={(e) => set('team_manager', { clubId: e.target.value, teamIds: [] })}
                data-testid="signup-team-club"
              />
            </Field>
            {tmClub && (
              tmClub.teams.length === 0
                ? <p className="text-xs text-stone-500">{t('access.requests.noTeams')}</p>
                : (
                  <div role="group" aria-label={t('access.requests.teams')} className="flex flex-col gap-1.5" data-testid="signup-teams">
                    <span className="text-sm font-medium text-stone-700">{t('access.requests.teams')}</span>
                    {tmClub.teams.map((team) => (
                      <Checkbox
                        key={team.id}
                        label={team.name}
                        checked={value.team_manager.teamIds.includes(team.id)}
                        onChange={(e) => set('team_manager', {
                          teamIds: e.target.checked
                            ? [...value.team_manager.teamIds, team.id]
                            : value.team_manager.teamIds.filter((x) => x !== team.id)
                        })}
                      />
                    ))}
                    {problem?.key === 'access.requests.needTeam' && <span className="text-xs font-medium text-red-600">{t(problem.key)}</span>}
                  </div>
                )
            )}
          </div>
        )}
      </div>

      {/* Club manager: a club */}
      <div>
        <Checkbox
          label={t('access.requests.kinds.club_manager')}
          hint={t('access.requests.clubManagerHint')}
          checked={value.club_manager.on}
          disabled={noClubs && !value.club_manager.on}
          onChange={(e) => set('club_manager', { on: e.target.checked })}
          data-testid="signup-request-club_manager"
        />
        {value.club_manager.on && (
          <div className="mt-2 pl-7">
            <Field label={t('access.requests.managedClub')} error={error('club_manager')}>
              <Select
                size="lg"
                block
                value={value.club_manager.clubId}
                placeholder={t('access.requests.pickClub')}
                options={clubOptions()}
                onChange={(e) => set('club_manager', { clubId: e.target.value })}
                data-testid="signup-managed-club"
              />
            </Field>
          </div>
        )}
      </div>
    </fieldset>
  )
}
