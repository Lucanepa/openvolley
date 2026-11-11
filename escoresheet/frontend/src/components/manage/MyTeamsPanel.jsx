import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FileUp, PenLine, Plus, Trash2, UserPlus } from 'lucide-react'
import { teamApi } from '../../lib/accountApi'
import { addClubPlayersToGameDraft, applyEinsatzlisteToGameDraft, clubPersonOf, clubPersonToPlayer, gameRosterBody, gameRosterDraft, officialOfRole, officialRolesOf, parsedPdfToRoster, playerFinder, roleForNewOfficial, setGameDraftOfficial, setGameDraftStaffRole, wrongGenderIndexes, GAME_ROSTER_MAX_PLAYERS, GAME_ROSTER_MAX_STAFF } from '../../domain/teamRosters'
import { STAFF_ROLES } from '../../domain/savedTeams'
import { shirtNumberDigits } from '../../domain/roster'
import TeamEditor, { clubPeopleOf, clubPersonOffer } from './TeamEditor'
import RequestsSection from './RequestsSection'
import ClubPlayerPickerModal from '../ClubPlayerPickerModal'
import ClubShield from './ClubShield'
import SignaturePad from '../SignaturePad'
import { usePanelData, usePanelRoute, useOnline, OfflineBanner, PageLoadGate, PageMissing, PanelHead, InlineError, useErrorText } from './common'
import { Button, Checkbox, Chip, DateField, EmptyInset, Field, Input, KeyValue, Notice, Row, RowList, RowTool, Select, SectionHeader, SkeletonRows, confirmDialog, dayLabel, timeLabel, toast, cn } from '../../ui'

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
 *
 * Pages (owner 2026-11-10: "new page with url with the game id" and "make
 * sure every page there gets their own page"): the team at #myteams/<team id>
 * and a game's roster at #myteams/<team id>/<game number> (usePanelRoute;
 * `route` and `onRoute` from the console). Without a route, the first team.
 */
export default function MyTeamsPanel({ teams = [], route = '', onRoute = null }) {
  const { t } = useTranslation()
  const [[routeTeam, routeGame], go] = usePanelRoute(route, onRoute)
  const byRoute = routeTeam ? teams.find((x) => x.id === routeTeam) : null
  const team = byRoute || teams[0]
  if (!team) return <EmptyInset>{t('manage.myTeams.none')}</EmptyInset>
  // a team of the URL this account does not manage (any more)
  if (routeTeam && !byRoute) return <PageMissing onBack={() => go([])} backLabel={t('manage.tabs.myteams')} />
  const gameNumber = byRoute && /^\d+$/.test(routeGame || '') ? routeGame : null
  return (
    <div className="space-y-8" data-testid="manage-my-teams">
      {teams.length > 1 && !gameNumber && (
        <Field label={t('manage.myTeams.pick')}>
          <Select value={team.id} onChange={(e) => go([e.target.value])} data-testid="my-teams-pick">
            {teams.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.club_name}</option>)}
          </Select>
        </Field>
      )}
      {/* keyed: another team starts its sections afresh, and appears whole
          (squad, games, the club's lists, the requests) */}
      <PageLoadGate key={team.id} className="space-y-8" fallback={<SkeletonRows rows={6} pill={false} />}>
        <TeamSections
          team={team}
          gameNumber={gameNumber}
          onOpenGame={(n) => go([team.id, n])}
          onCloseGame={() => go([team.id])}
        />
      </PageLoadGate>
    </div>
  )
}

function TeamSections({ team, gameNumber = null, onOpenGame, onCloseGame }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const squad = usePanelData(() => teamApi.squad(team.id), [team.id], { enabled: online })
  const games = usePanelData(() => teamApi.games(team.id), [team.id], { enabled: online })
  const saved = squad.data?.squad || null
  // db/024: the club's lists ("Add from club": the players list for the
  // players, everyone of the lists for the officials) and the team's gender;
  // a server or club without them simply offers nothing
  const club = usePanelData(() => teamApi.clubPlayers(team.id), [team.id], { enabled: online })
  const clubPlayers = useMemo(() => (club.data && Array.isArray(club.data.players)
    ? { players: club.data.players, gender: club.data.gender ?? null, people: clubPeopleOf(club.data) }
    : null), [club.data])
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
  // db/026: the ones typed by hand that Save's question puts into the club's
  // lists; the shields turn green with the club's fresh lists
  const addToClub = async (people) => {
    const res = await teamApi.addClubPeople(team.id, people)
    if (!res.error) club.reload({ quiet: true })
    return res
  }
  // a game's roster: its own page
  if (gameNumber) {
    const game = (games.data?.games || []).find((g) => String(g.game_number) === String(gameNumber)) || null
    if (!game) {
      return (
        <section data-testid="game-roster-page">
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onCloseGame} className="mb-3" data-testid="game-roster-back">{team.name}</Button>
          {games.error && <Notice className="mb-3">{errorText(games.error)}</Notice>}
          {games.loading || !games.data ? <SkeletonRows rows={4} pill={false} /> : <EmptyInset>{t('manage.myTeams.gameNotFound', { number: gameNumber })}</EmptyInset>}
        </section>
      )
    }
    return (
      <GameRosterPage
        key={game.game_number}
        team={team}
        game={game}
        squad={saved}
        squadLoading={squad.loading && !squad.data}
        clubPlayers={clubPlayers}
        onBack={onCloseGame}
        onSaved={() => { games.reload({ quiet: true }); onCloseGame() }}
      />
    )
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

      {/* db/025: who signed up as a manager or coach of this team */}
      <RequestsSection team={team} />

      <section>
        <PanelHead title={t('manage.myTeams.squad', { season: squad.data?.season || '' })} level={2} />
        <p className="mb-3 text-sm text-stone-500">{t('manage.myTeams.squadHint')}</p>
        {squad.error && <Notice className="mb-3">{errorText(squad.error)}</Notice>}
        {/* TeamEditor takes the club's lists when it opens: not before they are in */}
        {squad.error && !squad.data ? null : (squad.loading && !squad.data) || (club.loading && !club.data && !club.error) ? (
          <SkeletonRows rows={3} pill={false} />
        ) : squad.data && (
          <TeamEditor key={editorTeam.id} team={editorTeam} competition={null} online={online} fixedFields pdfImport saveRoster={saveSquad} clubPlayers={clubPlayers} onAddToClub={clubPlayers ? addToClub : null} clubName={team.club_name} />
        )}
      </section>

      <TeamGames games={games} onOpen={onOpenGame} />
    </>
  )
}

function TeamGames({ games: list, onOpen }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading } = list
  const games = data?.games || []
  return (
    <section>
      <PanelHead title={t('manage.myTeams.games')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t('manage.myTeams.gamesHint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !data ? null : loading && !data ? (
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
                  <RowTool disabled={!online} onClick={() => onOpen(g.game_number)} data-testid="my-team-game-roster">
                    {g.roster && !g.roster.used_at ? t('manage.myTeams.edit') : t('manage.myTeams.prepare')}
                  </RowTool>
                }
              />
            )
          })}
        </RowList>
      )}
    </section>
  )
}

/**
 * One game's roster, a page of its own: tick up to 14 players of the saved
 * team (or of an Einsatzliste), numbers, captain, liberos, officials. No lock
 * (owner 2026-11-08): it can be changed at any time. The coach and the
 * captain may sign ahead; a signature belongs to the roster it was made on,
 * so a change after signing asks for it again. A roster the scorer accepted
 * is gone from the server: a new one can be sent. Each official's role can
 * be changed, and officials can be added by hand (owner 2026-11-10: "have
 * people be put as P/M manually").
 */
function GameRosterPage({ team, game, squad, squadLoading = false, clubPlayers, onBack, onSaved }) {
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
  // ticking an official takes the role from whoever had it ticked (each role once)
  const setStaff = (key, patch) => change((d) => {
    const me = d.staff.find((s) => s.key === key)
    return {
      ...d,
      staff: d.staff.map((s) => {
        if (s.key === key) return { ...s, ...patch }
        if (patch.picked && me && s.picked && s.role === me.role) return { ...s, picked: false }
        return s
      })
    }
  })
  const setStaffRole = (key, role) => change((d) => setGameDraftStaffRole(d, key, role).draft)
  // an official typed by hand (a physiotherapist or medic from outside the club, say)
  const [newOfficial, setNewOfficial] = useState(null) // { role, first_name, last_name, dob, license_number }
  const addOfficial = () => {
    const o = newOfficial
    if (!o || !String(o.last_name || '').trim() || !shown) return
    change((d) => setGameDraftOfficial(d, o.role, { first_name: o.first_name, last_name: o.last_name, dob: o.dob || null, sv_number: o.license_number || null }).draft)
    setNewOfficial(null)
  }
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

  // An Einsatzliste for this game: its players are the ticked ones (with the
  // saved team's numbers: the list has none), its officials in its roles, the
  // saved team's others stay offered, unticked
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
      setDraft(applyEinsatzlisteToGameDraft(shown, imported).draft)
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
  // An official from anyone of the club's lists (either gender), ticked in its
  // role; the one ticked in that role before is unticked (each role once)
  const [officialPicker, setOfficialPicker] = useState(false)
  const staffRoles = STAFF_ROLES.map((r) => ({ value: r, label: t(STAFF_ROLE_KEYS[r], r) }))
  const pickedStaff = shown?.staff || []
  const officialFromClub = ([c], role) => {
    setOfficialPicker(false)
    if (!shown || !c || !role) return
    change((d) => setGameDraftOfficial(d, role, c).draft)
    toast.success(t('clubPlayers.officialSet', { role: t(STAFF_ROLE_KEYS[role], role), name: `${c.first_name || ''} ${c.last_name}`.trim() }))
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
      <section data-testid="game-roster-page">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} disabled={busy} className="mb-3" data-testid="game-roster-back">{team.name}</Button>
        <PanelHead title={`${game.side === 'home' ? t('manage.myTeams.vs') : t('manage.myTeams.at')} ${opponent || '–'}`}>
          <Chip tone={game.side === 'home' ? 'indigo' : 'stone'}>{game.side === 'home' ? t('manage.myTeams.home') : t('manage.myTeams.away')}</Chip>
        </PanelHead>
        {/* when, where, league, referees (owner 2026-11-10: "at the top where, when, referees etc") */}
        <GameFacts game={game} />
        <OfflineBanner online={online} />
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
          {(loading && !data) || squadLoading ? <SkeletonRows rows={4} pill={false} /> : shown && (
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
                      {clubPlayers && <ClubShield person={clubPersonOf(p, clubPlayers.people)} className="-my-1 -ml-2 -mr-2" />}
                      <Checkbox
                        checked={p.picked}
                        onChange={(e) => setPlayer(p.key, { picked: e.target.checked })}
                        label={<PersonLine person={p} />}
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
              <SectionHeader
                title={t('manage.myTeams.officials')}
                count={shown.staff.filter((s) => s.picked).length}
                action={(
                  <div className="flex flex-wrap items-center gap-1">
                    {clubPlayers && (
                      <Button variant="ghost" size="sm" icon={UserPlus} onClick={() => setOfficialPicker(true)} data-testid="game-official-from-club">{t('clubPlayers.add')}</Button>
                    )}
                    <Button variant="ghost" size="sm" icon={Plus} disabled={!!newOfficial || shown.staff.length >= GAME_ROSTER_MAX_STAFF * 3} onClick={() => setNewOfficial({ role: roleForNewOfficial(shown.staff), first_name: '', last_name: '', dob: '', license_number: '' })} data-testid="game-official-add">{t('savedTeams.addStaff')}</Button>
                  </div>
                )}
              />
              {shown.staff.length === 0 && !newOfficial ? (
                <EmptyInset>{t('manage.myTeams.noOfficials')}</EmptyInset>
              ) : shown.staff.length > 0 && (
                <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                  {shown.staff.map((s) => (
                    <li key={s.key} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2', !s.picked && 'bg-stone-50/60')} data-testid="game-staff-row">
                      {clubPlayers && <ClubShield person={clubPersonOf(s, clubPlayers.people)} className="-my-1 -ml-2 -mr-2" />}
                      <Checkbox
                        checked={s.picked}
                        onChange={(e) => setStaff(s.key, { picked: e.target.checked })}
                        label={<PersonLine person={s} />}
                        className="min-w-0 flex-1"
                      />
                      <Select
                        value={s.role}
                        onChange={(e) => setStaffRole(s.key, e.target.value)}
                        aria-label={`${t('savedTeams.role')} ${s.last_name}`}
                        className="w-full sm:w-48"
                        data-testid="game-staff-role"
                      >
                        {STAFF_ROLES.map((r) => <option key={r} value={r}>{t(STAFF_ROLE_KEYS[r], r)}</option>)}
                      </Select>
                    </li>
                  ))}
                </ul>
              )}
              {newOfficial && (
                <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3" data-testid="game-official-new">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr_1fr]">
                    <Field label={t('savedTeams.role')}>
                      <Select value={newOfficial.role} onChange={(e) => setNewOfficial((o) => ({ ...o, role: e.target.value }))} data-testid="game-official-new-role">
                        {STAFF_ROLES.map((r) => <option key={r} value={r}>{t(STAFF_ROLE_KEYS[r], r)}</option>)}
                      </Select>
                    </Field>
                    <Field label={t('savedTeams.firstName')}>
                      <Input value={newOfficial.first_name} onChange={(e) => setNewOfficial((o) => ({ ...o, first_name: e.target.value }))} maxLength={80} data-testid="game-official-new-first" />
                    </Field>
                    <Field label={t('savedTeams.lastName')}>
                      <Input value={newOfficial.last_name} onChange={(e) => setNewOfficial((o) => ({ ...o, last_name: e.target.value }))} maxLength={80} required data-testid="game-official-new-last" />
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_10rem]">
                    <Field label={t('savedTeams.dob')}>
                      <DateField value={newOfficial.dob} onChange={(v) => setNewOfficial((o) => ({ ...o, dob: v }))} />
                    </Field>
                    <Field label={t('savedTeams.license')}>
                      <Input value={newOfficial.license_number} onChange={(e) => setNewOfficial((o) => ({ ...o, license_number: e.target.value }))} maxLength={40} className="tabular-nums" />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="positive" size="sm" disabled={!String(newOfficial.last_name || '').trim()} onClick={addOfficial} data-testid="game-official-new-add">{t('common.add', 'Add')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setNewOfficial(null)}>{t('common.cancel', 'Cancel')}</Button>
                  </div>
                </div>
              )}
              <SectionHeader title={t('manage.myTeams.sig.title')} />
              <p className="text-xs text-stone-500">{t('manage.myTeams.signHint')}</p>
              {staleSigs && <div data-testid="game-sig-stale"><Notice tone="warning">{t('manage.myTeams.sig.stale')}</Notice></div>}
              <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                {sigRow('captain', captain, 'manage.myTeams.sig.noCaptain')}
                {sigRow('coach', coach, 'manage.myTeams.sig.noCoach')}
              </ul>
            </>
          )}
        </div>
        {/* the page's actions, at its foot */}
        <div className="sticky bottom-0 z-10 -mx-1 mt-6 flex flex-wrap items-center gap-2 border-t border-stone-200 bg-stone-100/95 px-1 py-3 backdrop-blur">
          {sent && (
            <Button variant="danger-outline" size="lg" icon={Trash2} onClick={remove} disabled={busy || !online}>{t('manage.myTeams.delete')}</Button>
          )}
          <InlineError error={saveError} className="min-w-0 flex-1" />
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="secondary" size="lg" onClick={onBack} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
            <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy || !online || !body || picked === 0} data-testid="game-roster-save">
              {t('manage.myTeams.send')}
            </Button>
          </div>
        </div>
      </section>
      <ClubPlayerPickerModal
        open={clubPicker}
        onClose={() => setClubPicker(false)}
        onPick={addFromClub}
        players={offered}
        zIndex={2050}
        isTaken={(c) => {
          const i = finder.find(clubPersonToPlayer(c))
          return i !== undefined && !!shown?.players[i]?.picked
        }}
      />
      <ClubPlayerPickerModal
        open={officialPicker}
        mode="officials"
        onClose={() => setOfficialPicker(false)}
        onPick={officialFromClub}
        players={clubPlayers?.people || []}
        zIndex={2050}
        roles={staffRoles}
        initialRole={STAFF_ROLES.find((r) => !officialOfRole(pickedStaff, r, { pickedOnly: true })) || STAFF_ROLES[0]}
        rolesOf={(c) => officialRolesOf(pickedStaff, c, { pickedOnly: true })}
        holderOf={(role) => {
          const s = officialOfRole(pickedStaff, role, { pickedOnly: true })
          return s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : null
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

/**
 * A person of a game's roster on one line (owner 2026-11-10: "all on one
 * line (bday, licence etc)"): the name, then the date of birth and the
 * licence number, quieter; it wraps only on a narrow screen.
 */
function PersonLine({ person }) {
  const { t } = useTranslation()
  const facts = [
    person.dob ? dayLabel(person.dob, { year: true }) : null,
    String(person.license_number || '').trim() ? t('clubPlayers.licence', { number: String(person.license_number).trim() }) : null
  ].filter(Boolean)
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-stone-900">{person.last_name} {person.first_name}</span>
      {facts.length > 0 && <span className="text-xs tabular-nums text-stone-500">{facts.join(' · ')}</span>}
    </span>
  )
}

/** The game's when, where (with a map link), league, game number and referees. */
function GameFacts({ game }) {
  const { t } = useTranslation()
  const place = [game.hall_address, [game.hall_postal_code, game.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const where = [game.hall, place].filter(Boolean).join(', ')
  // a server before the referees (no `referees`) leaves the line out rather than say "not assigned"
  const referees = Array.isArray(game.referees) ? game.referees : null
  const items = [
    { label: t('manage.myTeams.facts.when'), value: when(game.datetime) || '–' },
    {
      label: t('manage.myTeams.facts.where'),
      value: where
        ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`} target="_blank" rel="noopener noreferrer" className="text-red-600 underline decoration-red-300 underline-offset-2 hover:text-red-700">{where}</a>
        : '–'
    },
    { label: t('manage.myTeams.facts.league'), value: game.league || '–' },
    ...(referees ? [{ label: t('manage.myTeams.facts.referees'), value: referees.length ? referees.join(', ') : t('manage.myTeams.facts.noReferees') }] : []),
    { label: t('manage.myTeams.facts.game'), value: <span className="tabular-nums">#{game.game_number}</span> }
  ]
  return (
    <div className="mb-5 rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5" data-testid="game-facts">
      <KeyValue items={items} variant="stats" className="gap-y-3 text-sm" />
    </div>
  )
}
