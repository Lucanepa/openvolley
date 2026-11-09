import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { FileUp, PenLine, Trash2, UserPlus } from 'lucide-react'
import { teamApi } from '../../lib/accountApi'
import { addClubPlayersToGameDraft, clubPersonToPlayer, gameRosterBody, gameRosterDraft, parsedPdfToRoster, playerFinder, wrongGenderIndexes, GAME_ROSTER_MAX_PLAYERS } from '../../domain/teamRosters'
import { shirtNumberDigits } from '../../domain/roster'
import TeamEditor, { clubPersonOffer } from './TeamEditor'
import ClubPlayerPickerModal from '../ClubPlayerPickerModal'
import SignaturePad from '../SignaturePad'
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
  // db/024: the players list of the club ("Add from club") and the team's
  // gender; a server or club without it simply offers nothing
  const club = usePanelData(() => teamApi.clubPlayers(team.id), [team.id], { enabled: online })
  const clubPlayers = club.data && Array.isArray(club.data.players) ? { players: club.data.players, gender: club.data.gender ?? null } : null
  // TeamEditor's shape for a team without a saved team yet (the first save makes it)
  const editorTeam = useMemo(() => saved || { id: `new-${team.id}`, name: team.name, players: [], staff: [] }, [saved, team.id, team.name])
  const saveSquad = async (body) => {
    const res = await teamApi.putSquad(team.id, body)
    if (res.error) return res
    squad.reload({ quiet: true })
    // TeamEditor takes the saved players from data.team; this route's data.team
    // is the club's team and the saved squad is data.squad (an empty list after
    // Save until the page was reloaded)
    return { ...res, data: { ...res.data, team: res.data?.squad } }
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
          <TeamEditor key={editorTeam.id} team={editorTeam} competition={null} online={online} fixedFields pdfImport saveRoster={saveSquad} clubPlayers={clubPlayers} />
        )}
      </section>

      <TeamGames team={team} squad={saved} clubPlayers={clubPlayers} />
    </>
  )
}

function TeamGames({ team, squad, clubPlayers }) {
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
                  {g.roster?.used_at
                    ? <Chip tone="emerald">{t('manage.myTeams.accepted', { when: when(g.roster.used_at) })}</Chip>
                    : g.roster
                      ? <Chip tone="sky">{t('manage.myTeams.sent', { count: g.roster.players, when: when(g.roster.updated_at) })}</Chip>
                      : <Chip tone="amber">{t('manage.myTeams.notSent')}</Chip>}
                  {g.roster && !g.roster.used_at && g.roster.signed?.coach && g.roster.signed?.captain && <Chip>{t('manage.myTeams.signedChip')}</Chip>}
                </>}
                tools={
                  <RowTool disabled={!online} onClick={() => setOpen(g)} data-testid="my-team-game-roster">
                    {g.roster && !g.roster.used_at ? t('manage.myTeams.edit') : t('manage.myTeams.prepare')}
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
          clubPlayers={clubPlayers}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); reload({ quiet: true }) }}
        />
      )}
    </section>
  )
}

/**
 * One game's roster: tick up to 14 players of the saved team (or of an
 * Einsatzliste), numbers, captain, liberos, officials. No lock (owner
 * 2026-11-08): it can be changed at any time. The coach and the captain may
 * sign ahead; a signature belongs to the roster it was made on, so a change
 * after signing asks for it again. A roster the scorer accepted is gone from
 * the server: a new one can be sent.
 */
function GameRosterDialog({ team, game, squad, clubPlayers, onClose, onSaved }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading } = usePanelData(() => teamApi.roster(team.id, game.game_number), [team.id, game.game_number], { enabled: online })
  const sent = data?.roster && !data.roster.used_at ? data.roster : null
  const accepted = data?.roster?.used_at ? data.roster : null
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [importing, setImporting] = useState(false)
  // { coach: { image, key }, captain: { image, key } }: key = the roster signed
  const [sigs, setSigs] = useState(null)
  const [signing, setSigning] = useState(null) // 'coach' | 'captain'
  const pdfInput = useRef(null)
  // The draft starts once the sent roster (or its absence) is known
  const shown = draft || (data ? gameRosterDraft(squad, sent) : null)
  const change = (fn) => { setDraft(fn(shown)); setSaveError('') }
  const setPlayer = (key, patch) => change((d) => ({
    ...d,
    players: d.players.map((p) => (p.key === key ? { ...p, ...patch } : (patch.is_captain ? { ...p, is_captain: false } : p)))
  }))
  const setStaff = (key, patch) => change((d) => ({ ...d, staff: d.staff.map((s) => (s.key === key ? { ...s, ...patch } : s)) }))
  const { body, problems } = shown ? gameRosterBody(shown) : { body: null, problems: [] }
  const picked = body?.players.length || 0
  const bodyKey = body ? JSON.stringify(body) : ''
  // the signatures sent with the roster belong to it as it was loaded
  const loadedKey = useMemo(() => (data ? JSON.stringify(gameRosterBody(gameRosterDraft(squad, sent)).body) : ''), [data, squad, sent])
  const allSigs = sigs || {
    coach: sent?.coach_signature ? { image: sent.coach_signature, key: loadedKey } : null,
    captain: sent?.captain_signature ? { image: sent.captain_signature, key: loadedKey } : null
  }
  const validSig = (role) => (allSigs[role] && allSigs[role].key === bodyKey ? allSigs[role].image : null)
  const staleSigs = ['coach', 'captain'].some((r) => allSigs[r] && allSigs[r].key !== bodyKey)
  const coach = body?.staff.find((s) => s.role === 'Coach') || null
  const captain = body?.players.find((p) => p.is_captain) || null
  const saveSig = (image) => {
    setSigs({ ...allSigs, [signing]: image ? { image, key: bodyKey } : null })
    setSigning(null)
  }

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

  // db/024: "Add from club": ticked in the draft, added when not offered yet
  const [clubPicker, setClubPicker] = useState(false)
  const offered = useMemo(() => clubPersonOffer(clubPlayers), [clubPlayers])
  const finder = useMemo(() => playerFinder(shown?.players || []), [shown])
  const addFromClub = (chosen) => {
    setClubPicker(false)
    if (!shown) return
    const r = addClubPlayersToGameDraft(shown, chosen)
    change(() => r.draft)
    toast.success(t('clubPlayers.ticked', { count: r.added + r.ticked }))
  }
  const named = (p) => (p ? `${p.first_name} ${p.last_name}`.trim() : '')
  const wrongGender = (index) => `${t('manage.licences.wrongGender')} (${named(body?.players[index])})`

  const save = async () => {
    if (busy || !body) return
    if (problems.length) {
      setSaveError(t(problems[0].key, problems[0].params))
      return
    }
    // a player can't play in the wrong gender (the server checks the same)
    const wrong = clubPlayers ? wrongGenderIndexes(body.players, clubPlayers.players, clubPlayers.gender) : []
    if (wrong.length) {
      setSaveError(wrongGender(wrong[0]))
      return
    }
    setBusy(true)
    const res = await teamApi.putRoster(team.id, game.game_number, {
      ...body,
      coach_signature: coach ? validSig('coach') : null,
      captain_signature: captain ? validSig('captain') : null
    })
    setBusy(false)
    if (res.error) {
      setSaveError(res.error.code === 'OV_WRONG_GENDER' && Number.isInteger(res.error.index)
        ? wrongGender(res.error.index)
        : res.error.code === 'OV_INVALID_REQUEST' && res.error.details ? `${t('manage.errors.generic')} (${res.error.details})` : errorText(res.error))
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
  const sigRow = (role, person, missingKey) => {
    const image = validSig(role)
    return (
      <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2" data-testid={`game-sig-${role}`}>
        {/* the name keeps its line; image and buttons wrap under it on a phone */}
        <div className="min-w-[9rem] flex-1">
          <p className="m-0 text-sm font-medium text-stone-900">{t(`manage.myTeams.sig.${role}`)}</p>
          <p className="m-0 text-xs text-stone-500">{person ? `${person.last_name} ${person.first_name}`.trim() : t(missingKey)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {image && <img src={image} alt={t('manage.myTeams.sig.signed')} className="h-10 w-28 rounded border border-stone-200 bg-white object-contain" />}
          <Button variant="secondary" size="sm" icon={PenLine} disabled={!person || busy} onClick={() => setSigning(role)} data-testid={`game-sign-${role}`}>
            {image ? t('manage.myTeams.sig.again') : t('manage.myTeams.sig.sign')}
          </Button>
          {image && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSigs({ ...allSigs, [role]: null })}>{t('manage.myTeams.sig.clear')}</Button>
          )}
        </div>
      </li>
    )
  }
  return (
    <>
      <KitModal
        open
        onClose={() => { if (!busy && !signing) onClose() }}
        size="xl"
        dismissible={!busy && !signing}
        title={`${game.side === 'home' ? t('manage.myTeams.vs') : t('manage.myTeams.at')} ${opponent || '–'}`}
        description={`${when(game.datetime)} · #${game.game_number}`}
        closeLabel={t('common.close', 'Close')}
        footer={<>
          {sent && (
            <Button variant="danger-outline" size="lg" icon={Trash2} onClick={remove} disabled={busy || !online} className="mr-auto">{t('manage.myTeams.delete')}</Button>
          )}
          <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || !online || !body || picked === 0} data-testid="game-roster-save">
            {t('manage.myTeams.send')}
          </Button>
        </>}
      >
        <div className="space-y-4" data-testid="game-roster">
          {error && <Notice>{errorText(error)}</Notice>}
          {accepted && (
            <div data-testid="game-roster-accepted"><Notice tone="success">{t('manage.myTeams.acceptedBody', { when: when(accepted.used_at), name: accepted.used_by_name || '–' })}</Notice></div>
          )}
          {sent && (
            <p className="text-xs text-stone-500">
              {t('manage.myTeams.sentBy', { when: when(sent.updated_at), name: sent.updated_by_name || '–' })}
            </p>
          )}
          {loading && !data ? <SkeletonRows rows={4} pill={false} /> : shown && (
            <>
              <SectionHeader
                title={t('manage.myTeams.players')}
                count={`${picked}/${GAME_ROSTER_MAX_PLAYERS}`}
                action={(
                  <>
                    <input ref={pdfInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => importPdf(e.target.files?.[0])} data-testid="game-pdf-input" />
                    {clubPlayers && (
                      <Button variant="ghost" size="sm" icon={UserPlus} onClick={() => setClubPicker(true)} data-testid="game-add-from-club">{t('clubPlayers.add')}</Button>
                    )}
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
                          aria-label={`${t('savedTeams.number')} ${p.last_name}`}
                          className="w-16 text-center tabular-nums"
                        />
                        <Checkbox checked={p.is_captain} disabled={!p.picked} onChange={(e) => setPlayer(p.key, { is_captain: e.target.checked })} label={t('manage.myTeams.captainShort')} />
                        <Checkbox checked={p.is_libero} disabled={!p.picked} onChange={(e) => setPlayer(p.key, { is_libero: e.target.checked })} label={t('manage.myTeams.liberoShort')} />
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
                        onChange={(e) => setStaff(s.key, { picked: e.target.checked })}
                        label={<span className="font-medium text-stone-900">{s.last_name} {s.first_name}</span>}
                        hint={t(STAFF_ROLE_KEYS[s.role] || s.role)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <SectionHeader title={t('manage.myTeams.sig.title')} />
              <p className="text-xs text-stone-500">{t('manage.myTeams.signHint')}</p>
              {staleSigs && <div data-testid="game-sig-stale"><Notice tone="warning">{t('manage.myTeams.sig.stale')}</Notice></div>}
              <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                {sigRow('captain', captain, 'manage.myTeams.sig.noCaptain')}
                {sigRow('coach', coach, 'manage.myTeams.sig.noCoach')}
              </ul>
              <InlineError error={saveError} />
            </>
          )}
        </div>
      </KitModal>
      <ClubPlayerPickerModal
        open={clubPicker}
        onClose={() => setClubPicker(false)}
        onPick={addFromClub}
        players={offered.players}
        gender={offered.gender}
        hiddenCount={offered.hidden}
        zIndex={2050}
        isTaken={(c) => {
          const i = finder.find(clubPersonToPlayer(c))
          return i !== undefined && !!shown?.players[i]?.picked
        }}
      />
      {/* in a portal: the app's pad overlay renders in place, and inside the
          console it would sit under the dialog */}
      {signing && createPortal(<SignaturePad
        open={!!signing}
        onClose={() => setSigning(null)}
        onSave={(image) => saveSig(image)}
        zIndex={2100}
        title={signing === 'coach'
          ? t('manage.myTeams.sig.padCoach', { name: coach ? `${coach.first_name} ${coach.last_name}`.trim() : '' })
          : t('manage.myTeams.sig.padCaptain', { name: captain ? `${captain.first_name} ${captain.last_name}`.trim() : '' })}
      />, document.body)}
    </>
  )
}
