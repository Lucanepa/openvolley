import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Trash2 } from 'lucide-react'
import { teamApi } from '../../lib/accountApi'
import { gameRosterBody, gameRosterDraft, parsedPdfToRoster, GAME_ROSTER_MAX_PLAYERS } from '../../domain/teamRosters'
import { shirtNumberDigits } from '../../domain/roster'
import TeamEditor from './TeamEditor'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, Checkbox, Chip, EmptyInset, Field, Input, Notice, Row, RowList, RowTool, Select, SectionHeader, SkeletonRows, confirmDialog, dayLabel, timeLabel, toast, cn } from '../../ui'

const STAFF_ROLE_KEYS = {
  Coach: 'benchRoles.coach',
  'Assistant Coach 1': 'benchRoles.assistantCoach1',
  'Assistant Coach 2': 'benchRoles.assistantCoach2',
  Physiotherapist: 'benchRoles.physiotherapist',
  Medic: 'benchRoles.medic'
}
const when = (v) => [dayLabel(v, { year: true }), timeLabel(v)].filter(Boolean).join(' ')

/**
 * My teams (db/023, docs/team-managers-spec.md): what a team manager (or a
 * manager of the team's club) does for a team: its players and officials of
 * the season (a saved team, which scorers load in Match Setup), and the
 * roster of each of its games, sent ahead so the scoring tablet has it in the
 * hall without internet. An account with several teams picks one first.
 */
export default function MyTeamsPanel({ teams = [] }) {
  const { t } = useTranslation()
  const [teamId, setTeamId] = useState(teams[0]?.id || '')
  const team = teams.find((x) => x.id === teamId) || teams[0]
  if (!team) return <EmptyInset>{t('manage.myTeams.none')}</EmptyInset>
  return (
    <div className="space-y-8" data-testid="manage-my-teams">
      {teams.length > 1 && (
        <Field label={t('manage.myTeams.pick')}>
          <Select value={team.id} onChange={(e) => setTeamId(e.target.value)} data-testid="my-teams-pick">
            {teams.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.club_name}</option>)}
          </Select>
        </Field>
      )}
      {/* keyed: another team starts its sections afresh */}
      <TeamSections key={team.id} team={team} />
    </div>
  )
}

function TeamSections({ team }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const squad = usePanelData(() => teamApi.squad(team.id), [team.id], { enabled: online })
  const saved = squad.data?.squad || null
  // TeamEditor's shape for a team without a saved team yet (the first save makes it)
  const editorTeam = useMemo(() => saved || { id: `new-${team.id}`, name: team.name, players: [], staff: [] }, [saved, team.id, team.name])
  const saveSquad = async (body) => {
    const res = await teamApi.putSquad(team.id, body)
    if (!res.error) squad.reload({ quiet: true })
    return res
  }
  return (
    <>
      <section>
        <PanelHead title={team.name}>
          <p className="text-sm text-stone-500">{team.club_name}</p>
        </PanelHead>
        <OfflineBanner online={online} />
        <p className="mb-4 text-sm text-stone-600">{t('manage.myTeams.intro')}</p>
      </section>

      <section>
        <PanelHead title={t('manage.myTeams.squad', { season: squad.data?.season || '' })} level={2} />
        <p className="mb-3 text-sm text-stone-500">{t('manage.myTeams.squadHint')}</p>
        {squad.error && <Notice className="mb-3">{errorText(squad.error)}</Notice>}
        {squad.loading && !squad.data ? (
          <SkeletonRows rows={3} pill={false} />
        ) : squad.data && (
          <TeamEditor key={editorTeam.id} team={editorTeam} competition={null} online={online} fixedFields pdfImport saveRoster={saveSquad} />
        )}
      </section>

      <TeamGames team={team} squad={saved} />
    </>
  )
}

function TeamGames({ team, squad }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => teamApi.games(team.id), [team.id], { enabled: online })
  const games = data?.games || []
  const [open, setOpen] = useState(null) // the game whose roster is open
  return (
    <section>
      <PanelHead title={t('manage.myTeams.games')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t('manage.myTeams.gamesHint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={3} pill={false} />
      ) : games.length === 0 ? (
        <EmptyInset>{t('manage.myTeams.noGames')}</EmptyInset>
      ) : (
        <RowList data-testid="my-team-games">
          {games.map((g) => {
            const opponent = g.side === 'home' ? g.team_away : g.team_home
            return (
              <Row
                key={g.game_number}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={`${g.side === 'home' ? t('manage.myTeams.vs') : t('manage.myTeams.at')} ${opponent || '–'}`}
                meta={<>
                  <span>{when(g.datetime)}</span>
                  {g.league && <span>{g.league}</span>}
                  {g.hall && <span>{g.hall}</span>}
                  <span>#{g.game_number}</span>
                </>}
                chips={<>
                  <Chip tone={g.side === 'home' ? 'indigo' : 'stone'}>{g.side === 'home' ? t('manage.myTeams.home') : t('manage.myTeams.away')}</Chip>
                  {g.roster
                    ? <Chip tone="emerald">{t('manage.myTeams.sent', { count: g.roster.players, when: when(g.roster.updated_at) })}</Chip>
                    : <Chip tone="amber">{t('manage.myTeams.notSent')}</Chip>}
                  {g.locked && <Chip>{t('manage.myTeams.started')}</Chip>}
                </>}
                tools={
                  <RowTool disabled={!online} onClick={() => setOpen(g)} data-testid="my-team-game-roster">
                    {g.locked ? t('manage.myTeams.view') : g.roster ? t('manage.myTeams.edit') : t('manage.myTeams.prepare')}
                  </RowTool>
                }
              />
            )
          })}
        </RowList>
      )}
      {open && (
        <GameRosterDialog
          team={team}
          game={open}
          squad={squad}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); reload({ quiet: true }) }}
        />
      )}
    </section>
  )
}

/** One game's roster: tick up to 14 players of the saved team (or of an Einsatzliste), numbers, captain, liberos, officials. */
function GameRosterDialog({ team, game, squad, onClose, onSaved }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading } = usePanelData(() => teamApi.roster(team.id, game.game_number), [team.id, game.game_number], { enabled: online })
  const locked = !!(data?.locked ?? game.locked)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [importing, setImporting] = useState(false)
  const pdfInput = useRef(null)
  // The draft starts once the sent roster (or its absence) is known
  const shown = draft || (data ? gameRosterDraft(squad, data.roster) : null)
  const change = (fn) => { setDraft(fn(shown)); setSaveError('') }
  const setPlayer = (key, patch) => change((d) => ({
    ...d,
    players: d.players.map((p) => (p.key === key ? { ...p, ...patch } : (patch.is_captain ? { ...p, is_captain: false } : p)))
  }))
  const setStaff = (key, patch) => change((d) => ({ ...d, staff: d.staff.map((s) => (s.key === key ? { ...s, ...patch } : s)) }))
  const { body, problems } = shown ? gameRosterBody(shown) : { body: null, problems: [] }
  const picked = body?.players.length || 0

  // An Einsatzliste for this game: its players are the ticked ones (numbers
  // from the PDF), the saved team's others stay offered, unticked
  const importPdf = async (file) => {
    if (!file || importing || !shown) return
    setImporting(true)
    setSaveError('')
    try {
      const { parseRosterPdf } = await import('../../utils/parseRosterPdf')
      const imported = parsedPdfToRoster(await parseRosterPdf(file))
      if (!imported.players.length) {
        setSaveError(t('manage.myTeams.pdfEmpty'))
        return
      }
      const fromPdf = gameRosterDraft(null, { players: imported.players, staff: imported.staff })
      const keys = new Set(fromPdf.players.map((p) => p.key))
      const rest = shown.players.filter((p) => !keys.has(p.key)).map((p) => ({ ...p, picked: false }))
      const staffKeys = new Set(fromPdf.staff.map((s) => s.key))
      const restStaff = shown.staff.filter((s) => !staffKeys.has(s.key)).map((s) => ({ ...s, picked: false }))
      setDraft({ players: [...fromPdf.players.map((p) => ({ ...p, picked: true })), ...rest], staff: [...fromPdf.staff, ...restStaff] })
      toast.success(t('manage.myTeams.pdfImportedGame', { count: imported.players.length }))
    } catch (err) {
      console.warn('[MyTeams] Einsatzliste import failed:', err?.message)
      setSaveError(t('manage.myTeams.pdfFailed'))
    } finally {
      setImporting(false)
      if (pdfInput.current) pdfInput.current.value = ''
    }
  }

  const save = async () => {
    if (busy || !body) return
    if (problems.length) {
      setSaveError(t(problems[0].key, problems[0].params))
      return
    }
    setBusy(true)
    const res = await teamApi.putRoster(team.id, game.game_number, body)
    setBusy(false)
    if (res.error) {
      setSaveError(res.error.code === 'OV_INVALID_REQUEST' && res.error.details ? `${t('manage.errors.generic')} (${res.error.details})` : errorText(res.error))
      return
    }
    toast.success(t('manage.myTeams.saved'))
    onSaved()
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: t('manage.myTeams.deleteTitle'),
      message: t('manage.myTeams.deleteBody'),
      confirmLabel: t('manage.myTeams.delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    const res = await teamApi.deleteRoster(team.id, game.game_number)
    setBusy(false)
    if (res.error) {
      setSaveError(errorText(res.error))
      return
    }
    toast.success(t('manage.myTeams.deleted'))
    onSaved()
  }

  const opponent = game.side === 'home' ? game.team_away : game.team_home
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      size="xl"
      dismissible={!busy}
      title={`${game.side === 'home' ? t('manage.myTeams.vs') : t('manage.myTeams.at')} ${opponent || '–'}`}
      description={`${when(game.datetime)} · #${game.game_number}`}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        {data?.roster && !locked && (
          <Button variant="danger-outline" size="lg" icon={Trash2} onClick={remove} disabled={busy || !online} className="mr-auto">{t('manage.myTeams.delete')}</Button>
        )}
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{locked ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}</Button>
        {!locked && (
          <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || !online || !body || picked === 0} data-testid="game-roster-save">
            {t('manage.myTeams.send')}
          </Button>
        )}
      </>}
    >
      <div className="space-y-4" data-testid="game-roster">
        {error && <Notice>{errorText(error)}</Notice>}
        {locked && <Notice>{t('manage.myTeams.locked')}</Notice>}
        {data?.roster && (
          <p className="text-xs text-stone-500">
            {t('manage.myTeams.sentBy', { when: when(data.roster.updated_at), name: data.roster.updated_by_name || '–' })}
          </p>
        )}
        {loading && !data ? <SkeletonRows rows={4} pill={false} /> : shown && (
          <>
            <SectionHeader
              title={t('manage.myTeams.players')}
              count={`${picked}/${GAME_ROSTER_MAX_PLAYERS}`}
              action={!locked && (
                <>
                  <input ref={pdfInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => importPdf(e.target.files?.[0])} data-testid="game-pdf-input" />
                  <Button variant="ghost" size="sm" icon={FileUp} loading={importing} onClick={() => pdfInput.current?.click()}>{t('manage.myTeams.importPdf')}</Button>
                </>
              )}
            />
            {shown.players.length === 0 ? (
              <EmptyInset>{t('manage.myTeams.noPlayers')}</EmptyInset>
            ) : (
              <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                {shown.players.map((p) => (
                  <li key={p.key} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2', !p.picked && 'bg-stone-50/60')}>
                    <Checkbox
                      checked={p.picked}
                      disabled={locked}
                      onChange={(e) => setPlayer(p.key, { picked: e.target.checked })}
                      label={<span className="font-medium text-stone-900">{p.last_name} {p.first_name}</span>}
                      hint={p.dob ? dayLabel(p.dob, { year: true }) : undefined}
                      className="min-w-0 flex-1"
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        value={String(p.number ?? '')}
                        onChange={(e) => setPlayer(p.key, { number: shirtNumberDigits(e.target.value) })}
                        inputMode="numeric"
                        maxLength={2}
                        disabled={locked}
                        aria-label={`${t('savedTeams.number')} ${p.last_name}`}
                        className="w-16 text-center tabular-nums"
                      />
                      <Checkbox checked={p.is_captain} disabled={locked || !p.picked} onChange={(e) => setPlayer(p.key, { is_captain: e.target.checked })} label={t('manage.myTeams.captainShort')} />
                      <Checkbox checked={p.is_libero} disabled={locked || !p.picked} onChange={(e) => setPlayer(p.key, { is_libero: e.target.checked })} label={t('manage.myTeams.liberoShort')} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <SectionHeader title={t('manage.myTeams.officials')} count={shown.staff.filter((s) => s.picked).length} />
            {shown.staff.length === 0 ? (
              <EmptyInset>{t('manage.myTeams.noOfficials')}</EmptyInset>
            ) : (
              <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                {shown.staff.map((s) => (
                  <li key={s.key} className="px-3 py-2">
                    <Checkbox
                      checked={s.picked}
                      disabled={locked}
                      onChange={(e) => setStaff(s.key, { picked: e.target.checked })}
                      label={<span className="font-medium text-stone-900">{s.last_name} {s.first_name}</span>}
                      hint={t(STAFF_ROLE_KEYS[s.role] || s.role)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-stone-500">{t('manage.myTeams.signHint')}</p>
            <InlineError error={saveError} />
          </>
        )}
      </div>
    </KitModal>
  )
}
