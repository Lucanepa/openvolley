import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { clubApi } from '../../lib/accountApi'
import { usePanelData, useOnline, OfflineBanner, PageMissing, PanelHead } from './common'
import { Button, Chip, EmptyInset, KeyValue, Row, RowList, RowTool, SectionHeader, dayLabel } from '../../ui'

const LIST_TONE = { players: 'indigo', coaches: 'emerald', scorers: 'sky' }

/**
 * One person of a club's licence lists, a page of its own (#myclub/<club
 * id>/person/<licence number>; owner 2026-11-10: "every page there gets
 * their own page (team, club, game, player etc)"): the five fields, the
 * lists, whether added by hand, and the club's teams that have the person in
 * their squad (each opens in My teams with `onOpenTeam`).
 */
export default function ClubPersonPage({ club, svNumber, onBack, onOpenTeam = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const { data, error, loading } = usePanelData(() => clubApi.licences(club.id), [club.id], { enabled: online })
  const person = (data?.people || []).find((p) => String(p.sv_number) === String(svNumber)) || null
  if (!person) return <PageMissing loading={loading || !data} error={error} onBack={onBack} backLabel={club.name} />
  const name = `${person.last_name} ${person.first_name || ''}`.trim()
  const gender = person.gender === 'f' ? t('manage.licences.woman') : person.gender === 'm' ? t('manage.licences.man') : null
  const teams = Array.isArray(person.teams) ? person.teams : []
  return (
    <section data-testid="club-person-page">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} className="mb-3" data-testid="club-person-back">{club.name}</Button>
      <PanelHead title={name} />
      <OfflineBanner online={online} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(person.lists || []).map((l) => <Chip key={l} tone={LIST_TONE[l] || 'stone'}>{t(`manage.licences.lists.${l}`)}</Chip>)}
        {person.manual && <Chip tone="amber">{t('manage.licences.manual')}</Chip>}
      </div>
      <div className="mb-6 rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5">
        <KeyValue
          items={[
            { label: t('savedTeams.license'), value: <span className="tabular-nums">{person.sv_number}</span> },
            { label: t('savedTeams.dob'), value: person.dob ? dayLabel(person.dob, { year: true }) : '–' },
            { label: t('manage.licences.gender'), value: gender || '–' }
          ]}
        />
      </div>
      <SectionHeader title={t('manage.licences.personTeams')} count={teams.length} />
      {teams.length === 0 ? (
        <EmptyInset>{t('manage.licences.personNoTeams')}</EmptyInset>
      ) : (
        <RowList data-testid="club-person-teams">
          {teams.map((team) => (
            <Row
              key={team.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              title={team.name}
              tools={onOpenTeam ? <RowTool onClick={() => onOpenTeam(team.id)} data-testid="club-person-team-open">{t('manage.clubTeams.open')}</RowTool> : null}
            />
          ))}
        </RowList>
      )}
    </section>
  )
}
