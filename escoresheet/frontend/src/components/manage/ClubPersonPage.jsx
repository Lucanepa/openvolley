import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { clubApi } from '../../lib/accountApi'
import { usePanelData, useOnline, OfflineBanner, PageMissing, PanelHead, InlineError, useErrorText } from './common'
import { Button, Chip, EmptyInset, KeyValue, Row, RowList, RowTool, SectionHeader, confirmDialog, dayLabel, toast } from '../../ui'

const LIST_TONE = { players: 'indigo', coaches: 'emerald', scorers: 'sky' }

/**
 * One person of a club's licence lists, a page of its own (#myclub/<club
 * id>/person/<row id>; owner 2026-11-10: "every page there gets their own
 * page (team, club, game, player etc)"; db/037: the row id, never the
 * licence number, is in the URL): the five fields, the lists, whether added
 * by hand, and the club's teams that have the person in their squad (each
 * opens in My teams with `onOpenTeam`). A row added by hand (hand_rows) is
 * removed here, one list at a time; an uploaded one only by uploading its
 * list again.
 */
export default function ClubPersonPage({ club, personId, onBack, onOpenTeam = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubApi.licences(club.id), [club.id], { enabled: online })
  const [busy, setBusy] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const person = (data?.people || []).find((p) => p.id && String(p.id) === String(personId)) || null
  if (!person) return <PageMissing loading={loading || !data} error={error} onBack={onBack} backLabel={club.name} />
  const name = `${person.last_name} ${person.first_name || ''}`.trim()
  const gender = person.gender === 'f' ? t('manage.licences.woman') : person.gender === 'm' ? t('manage.licences.man') : null
  const teams = Array.isArray(person.teams) ? person.teams : []
  const handRows = Array.isArray(person.hand_rows) ? person.hand_rows : []
  const removeRow = async (row) => {
    if (busy) return
    const list = t(`manage.licences.lists.${row.list}`)
    const ok = await confirmDialog({
      title: t('manage.licences.removeRowTitle', { name, list }),
      message: t('manage.licences.removeRowBody'),
      confirmLabel: t('manage.licences.removeRow'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    setRemoveError('')
    const res = await clubApi.deleteLicenceRow(club.id, row.id)
    setBusy(false)
    if (res.error) {
      setRemoveError(errorText(res.error))
      return
    }
    toast.success(t('manage.licences.rowRemoved', { name, list }))
    // the person's only row: the person is gone, back to the club
    if ((person.lists || []).length <= 1) onBack()
    else reload({ quiet: true })
  }
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
      {handRows.length > 0 && (
        <div className="mb-6">
          <SectionHeader title={t('manage.licences.handRows')} count={handRows.length} />
          <RowList data-testid="club-person-hand-rows">
            {handRows.map((row) => (
              <Row
                key={row.id}
                stripe={false}
                toolsIndent="sm:pl-2"
                title={t(`manage.licences.lists.${row.list}`)}
                tools={<RowTool onClick={() => removeRow(row)} disabled={busy || !online} data-testid="club-person-remove-row">{t('manage.licences.removeRow')}</RowTool>}
              />
            ))}
          </RowList>
          <InlineError error={removeError} className="mt-1.5" />
        </div>
      )}
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
