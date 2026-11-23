import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { teamApi } from '../../lib/accountApi'
import { usePanelData, useOnline, PanelHead, InlineError, useErrorText } from './common'
import { Chip, Notice, Row, RowList, RowTool, confirmDialog, dayLabel, toast } from '../../ui'

const STAFF_ROLE_KEYS = {
  Coach: 'benchRoles.coach',
  'Assistant Coach 1': 'benchRoles.assistantCoach1',
  'Assistant Coach 2': 'benchRoles.assistantCoach2',
  Physiotherapist: 'benchRoles.physiotherapist',
  Medic: 'benchRoles.medic'
}
const fullName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')

/**
 * Rosters from other clubs' matches (db/058, owner decision 2026-11-23 no. 2,
 * audit 2611 PERM-04). An official match saves its rosters back only once it
 * is closed, and only to the team of a club its scorer belongs to: when
 * another club's scorer entered this team's roster, nothing of it reaches the
 * team's squad or the club's lists until someone who manages the team
 * confirms it here. Each row is one such match: the game, what confirming
 * would change now (new people, shirt numbers, officials' roles, new rows in
 * the club's lists; an older game's numbers do not count) and the roster as
 * the scorer entered it, new people marked. Confirm merges it into the squad
 * (as the team's own matches are), Reject keeps nothing; either is final.
 * `onDecided()`: after a confirm (the squad and the club's lists changed).
 * Nothing at all while there is none, or on a server without the route.
 */
export default function RosterSuggestionsPanel({ team, onDecided = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, reload } = usePanelData(() => teamApi.rosterSuggestions(team.id), [team.id], { enabled: online })
  const [busy, setBusy] = useState(null) // suggestion id
  const [rowError, setRowError] = useState({})
  // an older server answers 404: no section
  if (error?.status === 404 || error?.code === 'OV_NOT_FOUND') return null
  if (!data && !error) return null
  const list = data?.suggestions || []
  if (!error && list.length === 0) return null

  const decide = async (s, decision) => {
    if (decision === 'reject') {
      const ok = await confirmDialog({
        title: t('manage.myTeams.suggestions.rejectTitle'),
        message: t('manage.myTeams.suggestions.rejectBody', { number: s.game_number }),
        confirmLabel: t('manage.myTeams.suggestions.reject'),
        cancelLabel: t('common.cancel', 'Cancel'),
        tone: 'danger'
      })
      if (!ok) return
    }
    setBusy(s.id)
    setRowError((e) => ({ ...e, [s.id]: '' }))
    const res = await teamApi.decideRosterSuggestion(team.id, s.id, decision)
    setBusy(null)
    if (res.error) {
      if (res.error.code === 'OV_SUGGESTION_DECIDED') {
        toast.info(t('manage.myTeams.suggestions.gone'))
        reload({ quiet: true })
        return
      }
      setRowError((e) => ({ ...e, [s.id]: res.error.code === 'OV_MATCH_NOT_CLOSED' ? t('manage.myTeams.suggestions.notClosed') : errorText(res.error) }))
      return
    }
    toast.success(t(decision === 'confirm' ? 'manage.myTeams.suggestions.confirmed' : 'manage.myTeams.suggestions.rejected'))
    reload({ quiet: true })
    if (decision === 'confirm') onDecided?.()
  }

  const effects = (s) => {
    const c = s.counts || {}
    const out = []
    if (c.added) out.push(t('manage.myTeams.suggestions.added', { count: c.added }))
    if (c.numbers) out.push(t('manage.myTeams.suggestions.numbers', { count: c.numbers }))
    if (c.roles) out.push(t('manage.myTeams.suggestions.roles', { count: c.roles }))
    if (s.club_new) out.push(t('manage.myTeams.suggestions.clubNew', { count: s.club_new }))
    return out
  }

  return (
    <section data-testid="roster-suggestions">
      <PanelHead title={t('manage.myTeams.suggestions.title')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t('manage.myTeams.suggestions.hint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {list.length > 0 && (
        <RowList>
          {list.map((s) => {
            const what = effects(s)
            return (
              <Row
                key={s.id}
                data-testid={`roster-suggestion-${s.id}`}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={[t('manage.myTeams.suggestions.game', { number: s.game_number }), [s.team_home, s.team_away].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')}
                meta={<>
                  {s.kickoff && <span>{dayLabel(s.kickoff, { year: true })}</span>}
                  {s.latest === false && <span data-testid={`roster-suggestion-older-${s.id}`}>{t('manage.myTeams.suggestions.older')}</span>}
                </>}
                chips={what.length
                  ? what.map((w) => <Chip key={w} tone="amber">{w}</Chip>)
                  : <Chip>{t('manage.myTeams.suggestions.nothing')}</Chip>}
                tools={<>
                  <RowTool primary disabled={!online || busy === s.id} onClick={() => decide(s, 'confirm')} data-testid={`roster-suggestion-confirm-${s.id}`}>{t('manage.myTeams.suggestions.confirm')}</RowTool>
                  <RowTool disabled={!online || busy === s.id} onClick={() => decide(s, 'reject')} data-testid={`roster-suggestion-reject-${s.id}`}>{t('manage.myTeams.suggestions.reject')}</RowTool>
                  <InlineError error={rowError[s.id]} className="ml-1" />
                </>}
              >
                <ul className="mt-2 space-y-0.5 text-xs text-stone-600" data-testid={`roster-suggestion-people-${s.id}`}>
                  {(s.players || []).map((p, i) => (
                    <li key={`p${i}`} className="flex flex-wrap items-center gap-x-2">
                      <span className="w-6 shrink-0 text-right tabular-nums text-stone-500">{p.number ?? ''}</span>
                      <span className="font-medium text-stone-800">{fullName(p)}</span>
                      {p.license_number && <span className="tabular-nums text-stone-500">{p.license_number}</span>}
                      {!p.known && <Chip tone="sky">{t('manage.myTeams.suggestions.new')}</Chip>}
                    </li>
                  ))}
                  {(s.staff || []).map((p, i) => (
                    <li key={`s${i}`} className="flex flex-wrap items-center gap-x-2">
                      <span className="w-6 shrink-0" />
                      <span className="font-medium text-stone-800">{fullName(p)}</span>
                      <span className="text-stone-500">{t(STAFF_ROLE_KEYS[p.role] || p.role, p.role)}</span>
                      {p.license_number && <span className="tabular-nums text-stone-500">{p.license_number}</span>}
                      {!p.known && <Chip tone="sky">{t('manage.myTeams.suggestions.new')}</Chip>}
                    </li>
                  ))}
                </ul>
              </Row>
            )
          })}
        </RowList>
      )}
    </section>
  )
}
