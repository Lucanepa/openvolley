import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save } from 'lucide-react'
import KitModal from './manage/KitModal'
import { useSavedTeams } from '../hooks/useSavedTeams'
import { savedTeamsApi, errorKeyOf } from '../lib/accountApi'
import { refreshSavedTeams } from '../db/savedTeams'
import { rosterToSavedRoster, validateSavedRoster, normalizeName } from '../domain/savedTeams'
import { Button, Field, Input, Select, SegmentedControl, Banner, confirmDialog, toast } from '../ui'

const HEX = /^#[0-9a-f]{6}$/i

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * "Save roster to team" (competition managers and admins, online): store
 * MatchSetup's roster and team officials as a saved team, new or existing.
 */
export default function SaveRosterToTeamModal({ open, onClose, userId, access, roster, bench, meta, suggestedTeamId = null }) {
  if (!open) return null
  return <SaveBody {...{ onClose, userId, access, roster, bench, meta, suggestedTeamId }} />
}

function SaveBody({ onClose, userId, access, roster, bench, meta, suggestedTeamId }) {
  const { t } = useTranslation()
  const { teams, competitions } = useSavedTeams({ userId, access, refreshOnMount: true })
  const online = isOnline()

  const openCompetitions = useMemo(
    () => competitions.filter(c => !c.archived).sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name)),
    [competitions]
  )
  const suggested = teams.find(team => team.id === suggestedTeamId) ||
    teams.find(team => !team.competition?.archived && meta?.name && (normalizeName(team.name) === normalizeName(meta.name) || normalizeName(team.svrzTeamName) === normalizeName(meta.name))) ||
    null

  const [competitionId, setCompetitionId] = useState('')
  const [mode, setMode] = useState('existing')
  const [teamId, setTeamId] = useState('')
  const [name, setName] = useState(meta?.name || '')
  const [shortName, setShortName] = useState(meta?.shortName || '')
  const [color, setColor] = useState(HEX.test(meta?.color || '') ? meta.color : '#e2001a')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Pre-select the suggestion (or a name match) once the cache is read
  useEffect(() => {
    if (competitionId) return
    if (suggested) {
      setCompetitionId(suggested.competitionId)
      setTeamId(suggested.id)
      setMode('existing')
    } else if (openCompetitions[0]) {
      setCompetitionId(openCompetitions[0].id)
    }
  }, [suggested, openCompetitions, competitionId])

  const competitionTeams = useMemo(
    () => teams.filter(team => team.competitionId === competitionId).sort((a, b) => a.name.localeCompare(b.name)),
    [teams, competitionId]
  )
  useEffect(() => {
    if (mode === 'existing' && competitionTeams.length === 0) setMode('new')
    if (mode === 'existing' && teamId && !competitionTeams.some(team => team.id === teamId)) setTeamId('')
  }, [mode, competitionTeams, teamId])

  const target = mode === 'existing' ? competitionTeams.find(team => team.id === teamId) : null
  const canSave = online && !busy && competitionId && (mode === 'existing' ? !!target : name.trim().length > 0)

  const save = async () => {
    if (!canSave) return
    setError('')
    const body = rosterToSavedRoster(roster, bench, target)
    const problems = validateSavedRoster(body)
    if (problems.length) {
      const first = problems[0]
      setError(`${t(first.key, first.params)}${first.index !== null ? ` (${first.list === 'staff' ? t('savedTeams.staff') : t('savedTeams.players')} ${first.index + 1})` : ''}`)
      return
    }
    if (target) {
      const ok = await confirmDialog({
        title: t('savedTeams.saveConfirmTitle', { name: target.name }),
        message: t('savedTeams.saveConfirmBody'),
        confirmLabel: t('savedTeams.saveRoster'),
        cancelLabel: t('common.cancel', 'Cancel'),
        tone: 'danger'
      })
      if (!ok) return
    }
    setBusy(true)
    let id = target?.id
    let label = target?.name
    if (!id) {
      const res = await savedTeamsApi.createTeam({
        competition_id: competitionId,
        name: name.trim(),
        short_name: shortName.trim() || null,
        color: HEX.test(color) ? color.toLowerCase() : null,
        svrz_team_name: meta?.svrzTeamName || null
      })
      if (res.error) {
        setBusy(false)
        setError(t(errorKeyOf(res.error)))
        return
      }
      id = res.data?.team?.id
      label = res.data?.team?.name || name.trim()
    }
    const put = await savedTeamsApi.putRoster(id, body)
    setBusy(false)
    if (put.error) {
      setError(put.error.code === 'OV_INVALID_REQUEST' && put.error.details ? `${t('manage.errors.generic')} (${put.error.details})` : t(errorKeyOf(put.error)))
      return
    }
    await refreshSavedTeams({ force: true, access, userId }).catch(() => {})
    toast.success(t('savedTeams.saved', { name: label }))
    onClose?.()
  }

  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose?.() }}
      decision
      dismissible={false}
      layout="sections"
      size="md"
      title={t('savedTeams.saveTitle')}
      icon={Save}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={!canSave} data-testid="save-roster-to-team">
          {t('savedTeams.saveRoster')}
        </Button>
      </>}
    >
      {!online && <Banner tone="warning">{t('manage.errors.offline')}</Banner>}
      <Field label={t('savedTeams.pickerCompetition')}>
        <Select value={competitionId} onChange={e => { setCompetitionId(e.target.value); setTeamId('') }} required>
          {!competitionId && <option value="">–</option>}
          {openCompetitions.map(c => <option key={c.id} value={c.id}>{c.name} · {c.season}</option>)}
        </Select>
      </Field>
      <SegmentedControl
        ariaLabel={t('savedTeams.teams')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'existing', label: t('savedTeams.saveExisting') },
          { value: 'new', label: t('savedTeams.saveNew') }
        ]}
      />
      {mode === 'existing' ? (
        <Field label={t('savedTeams.teamName')}>
          <Select value={teamId} onChange={e => setTeamId(e.target.value)} required>
            <option value="">–</option>
            {competitionTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
          </Select>
        </Field>
      ) : (
        <div className="space-y-3">
          <Field label={t('savedTeams.teamName')}>
            <Input value={name} onChange={e => setName(e.target.value)} maxLength={120} required />
          </Field>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <Field label={t('savedTeams.shortName')}>
              <Input value={shortName} onChange={e => setShortName(e.target.value)} maxLength={20} />
            </Field>
            <Field label={t('savedTeams.color')}>
              <div className="flex gap-2">
                <input type="color" value={HEX.test(color) ? color : '#e2001a'} onChange={e => setColor(e.target.value)} aria-label={t('savedTeams.color')} className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-stone-300 bg-white p-1" />
                <Input value={color} onChange={e => setColor(e.target.value)} maxLength={7} className="font-mono" aria-label={`${t('savedTeams.color')} (hex)`} />
              </div>
            </Field>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs font-medium text-red-600">{error}</p>}
    </KitModal>
  )
}
