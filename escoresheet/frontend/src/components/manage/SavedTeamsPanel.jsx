import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { savedTeamsApi, errorKeyOf } from '../../lib/accountApi'
import { apiFrom } from '../../lib/apiClient'
import { storeSavedTeamsBundle } from '../../db/savedTeams'
import { seasonOptions, seasonOf, seasonLabel } from '../../domain/season'
import { sportOf, beachSeasonOptions } from '../../domain/savedTeams'
import KitModal from './KitModal'
import TeamEditor from './TeamEditor'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, Field, Input, Select, Switch, RowList, Row, Chip, EmptyInset, SkeletonRows, Notice, FilterPill, SegmentedControl, confirmDialog, toast } from '../../ui'

const GENDERS = ['men', 'women', 'mixed']
const SPORT_KEY = 'ov_saved_teams_sport'

function readSport() {
  try { return localStorage.getItem(SPORT_KEY) === 'beach' ? 'beach' : 'indoor' } catch { return 'indoor' }
}
function writeSport(sport) {
  try { localStorage.setItem(SPORT_KEY, sport) } catch { /* private mode: not remembered */ }
}
const SVRZ_GENDER = {
  men: ['m', 'men', 'male', 'h', 'herren', 'hommes', 'uomini', 'masculin'],
  women: ['f', 'w', 'women', 'female', 'd', 'damen', 'dames', 'donne', 'feminin', 'féminin']
}

/** VolleyManager league names from svrz_games, for one gender (all when unknown). */
export function leaguesForGender(rows, gender) {
  const wanted = SVRZ_GENDER[gender]
  const set = new Set()
  for (const r of rows || []) {
    if (!r?.league) continue
    if (wanted && r.gender && !wanted.includes(String(r.gender).trim().toLowerCase())) continue
    set.add(r.league)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/**
 * Saved teams (competition manager): competitions, their teams, and each
 * team's players and officials. Admins and competition managers; the server
 * enforces it. Every successful write also refreshes the offline cache.
 *
 * One console for indoor and beach (docs/beach-saved-teams-spec.md 3.5): it
 * loads every sport and switches between them; the offline cache keeps only
 * the indoor teams (storeSavedTeamsBundle filters), since beach teams are
 * loaded by OpenBeach.
 */
export default function SavedTeamsPanel({ userId }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [season, setSeason] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [competitionId, setCompetitionId] = useState(null)
  const [teamId, setTeamId] = useState(null)
  const [competitionForm, setCompetitionForm] = useState(null) // null | {} (new) | competition (edit)
  const [teamFormOpen, setTeamFormOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [sport, setSportState] = useState(readSport)
  const setSport = (v) => {
    setSportState(v)
    setSeason('')
    writeSport(v)
  }

  const { data, error, loading, reload } = usePanelData(async () => {
    const res = await savedTeamsApi.fetchBundle({ sport: 'all' })
    if (!res.error && res.data && userId) {
      // The console's load is also the cache refresh for MatchSetup
      try { await storeSavedTeamsBundle(res.data, userId) } catch { /* cache is best effort */ }
    }
    return res
  }, [userId], { enabled: online })

  const competitions = data?.competitions || []
  const teams = data?.teams || []
  const sportCompetitions = useMemo(() => competitions.filter(c => sportOf(c) === sport), [competitions, sport])
  const seasons = useMemo(() => [...new Set(sportCompetitions.map(c => c.season))].sort().reverse(), [sportCompetitions])
  const visible = sportCompetitions
    .filter(c => showArchived || !c.archived)
    .filter(c => !season || c.season === season)
    .sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name))
  const competition = competitions.find(c => c.id === competitionId) || null
  const team = teams.find(x => x.id === teamId) || null

  const afterWrite = async () => {
    setActionError('')
    await reload()
  }

  const deleteCompetition = async (c) => {
    const ok = await confirmDialog({
      title: t('savedTeams.deleteCompetitionConfirmTitle', { name: c.name }),
      message: t('savedTeams.deleteCompetitionConfirmBody'),
      confirmLabel: t('savedTeams.deleteCompetition'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await savedTeamsApi.deleteCompetition(c.id)
    if (res.error) return setActionError(errorText(res.error))
    setCompetitionId(null)
    afterWrite()
  }

  // ── Team editor ──
  if (team && competition) {
    return (
      <section>
        <PanelHead title={team.name} />
        <OfflineBanner online={online} />
        {/* Keyed on the id only: a save reloads the bundle (new updated_at),
            and a remount would drop the other section's unsaved edits. */}
        <TeamEditor
          key={team.id}
          team={team}
          competition={competition}
          online={online}
          onBack={() => setTeamId(null)}
          onChanged={afterWrite}
          onDeleted={() => { setTeamId(null); afterWrite() }}
        />
      </section>
    )
  }

  // ── Teams of one competition ──
  if (competition) {
    const compTeams = teams.filter(x => x.competition_id === competition.id).sort((a, b) => a.name.localeCompare(b.name))
    const beach = sportOf(competition) === 'beach'
    return (
      <section>
        <div className="mb-2">
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => setCompetitionId(null)}>{t('savedTeams.competitions')}</Button>
        </div>
        <PanelHead title={competition.name}>
          <Button variant="secondary" icon={Pencil} onClick={() => setCompetitionForm(competition)} disabled={!online}>{t('common.edit', 'Edit')}</Button>
          <Button icon={Plus} onClick={() => setTeamFormOpen(true)} disabled={!online}>{t('savedTeams.newTeam')}</Button>
        </PanelHead>
        <OfflineBanner online={online} />
        <div className="mb-3 flex flex-wrap gap-1.5">
          {beach && <Chip tone="sky">{t('savedTeams.sportBeach')}</Chip>}
          <Chip>{competition.season}</Chip>
          {competition.gender && <Chip>{t(`savedTeams.gender${competition.gender[0].toUpperCase()}${competition.gender.slice(1)}`)}</Chip>}
          {competition.category && <Chip>{competition.category}</Chip>}
          {(competition.vm_leagues || []).map(l => <Chip key={l} tone="indigo">{l}</Chip>)}
          {competition.archived && <Chip tone="amber">{t('savedTeams.archived')}</Chip>}
        </div>
        <InlineError error={actionError} className="mb-2" />
        {compTeams.length === 0 ? (
          <EmptyInset>{t('savedTeams.emptyTeams')}</EmptyInset>
        ) : (
          <RowList>
            {compTeams.map(x => {
              const active = beach ? (x.players || []).length : (x.players || []).filter(p => p.active !== false).length
              return (
                <Row
                  key={x.id}
                  stripe={false}
                  title={<p className="flex items-center gap-2 text-sm font-semibold text-stone-900 sm:text-[15px]">
                    {x.color && <span aria-hidden className="inline-block h-3 w-3 rounded-full border border-stone-300" style={{ backgroundColor: x.color }} />}
                    {x.name}
                  </p>}
                  meta={<>
                    {x.club && <span>{x.club}</span>}
                    {x.svrz_team_name && <span>{x.svrz_team_name}</span>}
                  </>}
                  status={<Chip>{t('savedTeams.pickerPlayers', { count: active })}</Chip>}
                  onOpen={() => setTeamId(x.id)}
                  label={x.name}
                />
              )
            })}
          </RowList>
        )}
        <div className="mt-6 flex justify-end">
          <Button variant="danger-outline" size="sm" icon={Trash2} onClick={() => deleteCompetition(competition)} disabled={!online}>{t('savedTeams.deleteCompetition')}</Button>
        </div>
        <CompetitionModal form={competitionForm} sport={sportOf(competition)} onClose={() => setCompetitionForm(null)} onSaved={() => { setCompetitionForm(null); afterWrite() }} />
        <NewTeamModal
          open={teamFormOpen}
          competition={competition}
          onClose={() => setTeamFormOpen(false)}
          onCreated={(created) => { setTeamFormOpen(false); afterWrite().then(() => created?.id && setTeamId(created.id)) }}
        />
      </section>
    )
  }

  // ── Competitions ──
  return (
    <section>
      <PanelHead title={t('savedTeams.competitions')}>
        <Button icon={Plus} onClick={() => setCompetitionForm({})} disabled={!online}>{t('savedTeams.newCompetition')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      <div className="mb-3">
        <SegmentedControl
          ariaLabel={t('savedTeams.sport')}
          value={sport}
          onChange={setSport}
          options={[
            { value: 'indoor', label: t('savedTeams.sportIndoor') },
            { value: 'beach', label: t('savedTeams.sportBeach') }
          ]}
        />
      </div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={season} onChange={e => setSeason(e.target.value)} aria-label={t('savedTeams.season')} className="sm:w-48">
          <option value="">{t('savedTeams.season')}: –</option>
          {seasons.map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
        <label className="inline-flex items-center gap-2 text-sm text-stone-700">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label={t('savedTeams.showArchived')} />
          {t('savedTeams.showArchived')}
        </label>
      </div>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      <InlineError error={actionError} className="mb-2" />
      {loading && !data ? (
        <SkeletonRows rows={4} pill={false} />
      ) : visible.length === 0 ? (
        <EmptyInset>{t('savedTeams.emptyCompetitions')}</EmptyInset>
      ) : (
        <RowList>
          {visible.map(c => {
            const count = teams.filter(x => x.competition_id === c.id).length
            return (
              <Row
                key={c.id}
                stripe={false}
                title={c.name}
                meta={<>
                  <span className="tabular-nums">{c.season}</span>
                  {c.gender && <span>{t(`savedTeams.gender${c.gender[0].toUpperCase()}${c.gender.slice(1)}`)}</span>}
                  {c.category && <span>{c.category}</span>}
                  <span>{t('savedTeams.teams')}: {count}</span>
                </>}
                status={c.archived ? <Chip tone="amber">{t('savedTeams.archived')}</Chip> : null}
                onOpen={() => setCompetitionId(c.id)}
                label={c.name}
              />
            )
          })}
        </RowList>
      )}
      <CompetitionModal form={competitionForm} sport={sport} onClose={() => setCompetitionForm(null)} onSaved={() => { setCompetitionForm(null); afterWrite() }} />
    </section>
  )
}

/** A new competition takes the console's sport; an existing one keeps its own (never editable). */
function CompetitionModal({ form, sport = 'indoor', onClose, onSaved }) {
  const { t } = useTranslation()
  const editing = !!form?.id
  const compSport = editing ? sportOf(form) : sport
  const beach = compSport === 'beach'
  const defaultSeason = () => (beach ? beachSeasonOptions()[1] : seasonLabel(seasonOf(new Date())))
  const [name, setName] = useState('')
  const [season, setSeason] = useState(defaultSeason)
  const [gender, setGender] = useState('')
  const [category, setCategory] = useState('')
  const [leagues, setLeagues] = useState([])
  const [archived, setArchived] = useState(false)
  const [free, setFree] = useState('')
  const [svrzRows, setSvrzRows] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!form) return
    setName(form.name || '')
    setSeason(form.season || defaultSeason())
    setGender(form.gender || '')
    setCategory(form.category || '')
    setLeagues(form.vm_leagues || [])
    setArchived(!!form.archived)
    setFree('')
    setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, compSport])

  // League names known from the official schedule (VolleyManager is indoor only)
  useEffect(() => {
    if (!form || beach) return undefined
    let alive = true
    apiFrom('svrz_games').select('league, gender').limit(5000).then(({ data }) => {
      if (alive && Array.isArray(data)) setSvrzRows(data)
    })
    return () => { alive = false }
  }, [form, beach])

  if (!form) return null
  const seasons = [...new Set([...(beach ? beachSeasonOptions() : seasonOptions(new Date(), 1)), ...(form.season ? [form.season] : [])])].sort()
  const known = leaguesForGender(svrzRows, gender)
  const allLeagues = [...new Set([...known, ...leagues])]
  const toggleLeague = (l) => setLeagues(list => (list.includes(l) ? list.filter(x => x !== l) : (list.length >= 20 ? list : [...list, l])))
  const addFree = () => {
    const v = free.trim().slice(0, 60)
    if (v && !leagues.includes(v) && leagues.length < 20) setLeagues(list => [...list, v])
    setFree('')
  }

  const submit = async (e) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    const body = { name: name.trim(), season, gender: gender || null, category: category.trim() || null }
    if (!beach) body.vm_leagues = leagues
    if (editing) body.archived = archived
    else {
      body.sport = compSport
      if (beach) body.vm_leagues = []
    }
    const res = editing ? await savedTeamsApi.updateCompetition(form.id, body) : await savedTeamsApi.createCompetition(body)
    setBusy(false)
    if (res.error) {
      setError(t(errorKeyOf(res.error)))
      return
    }
    toast.success(t('manage.accounts.saved'))
    onSaved()
  }

  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      layout="sections"
      size="lg"
      title={editing ? form.name : t('savedTeams.newCompetition')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={submit} loading={busy} disabled={!name.trim() || busy}>{t('manage.accounts.save')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Chip tone={beach ? 'sky' : 'stone'}>{t(beach ? 'savedTeams.sportBeach' : 'savedTeams.sportIndoor')}</Chip>
        </div>
        <Field label={t('savedTeams.competitionName')}>
          <Input value={name} onChange={e => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <Field label={t('savedTeams.season')}>
            <Select value={season} onChange={e => setSeason(e.target.value)}>
              {seasons.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label={t('savedTeams.gender')}>
            <Select value={gender} onChange={e => setGender(e.target.value)}>
              <option value="">–</option>
              {GENDERS.map(g => <option key={g} value={g}>{t(`savedTeams.gender${g[0].toUpperCase()}${g.slice(1)}`)}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t('savedTeams.category')} hint={t('savedTeams.categoryHint')}>
          <Input value={category} onChange={e => setCategory(e.target.value)} maxLength={60} />
        </Field>
        {!beach && (
          <>
            <Field label={t('savedTeams.vmLeagues')} hint={t('savedTeams.vmLeaguesHint')}>
              <div className="flex gap-2">
                <Input value={free} onChange={e => setFree(e.target.value)} maxLength={60} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFree() } }} aria-label={t('savedTeams.vmLeagues')} />
                <Button type="button" variant="secondary" onClick={addFree} disabled={!free.trim()}>{t('common.add', 'Add')}</Button>
              </div>
            </Field>
            {allLeagues.length > 0 && (
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                {allLeagues.map(l => (
                  <FilterPill key={l} active={leagues.includes(l)} onClick={() => toggleLeague(l)}>{l}</FilterPill>
                ))}
              </div>
            )}
          </>
        )}
        {editing && (
          <label className="inline-flex items-center gap-2 text-sm text-stone-700">
            <Switch checked={archived} onCheckedChange={setArchived} aria-label={t('savedTeams.archived')} />
            {t('savedTeams.archived')}
          </label>
        )}
        <InlineError error={error} />
        <button type="submit" hidden />
      </form>
    </KitModal>
  )
}

function NewTeamModal({ open, competition, onClose, onCreated }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setName(''); setError('') } }, [open])
  const submit = async (e) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const res = await savedTeamsApi.createTeam({ competition_id: competition.id, name: name.trim() })
    setBusy(false)
    if (res.error) {
      setError(t(errorKeyOf(res.error)))
      return
    }
    onCreated(res.data?.team)
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      title={t('savedTeams.newTeam')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={submit} loading={busy} disabled={!name.trim() || busy}>{t('manage.accounts.save')}</Button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label={t('savedTeams.teamName')}>
          <Input value={name} onChange={e => { setName(e.target.value); setError('') }} maxLength={120} required autoFocus />
        </Field>
        <InlineError error={error} className="mt-1.5" />
      </form>
    </KitModal>
  )
}
