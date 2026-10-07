import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Shuffle, Trash2, UserMinus } from 'lucide-react'
import KitModal from '../KitModal'
import { InlineError } from '../common'
import { tournamentApi } from '../../../lib/tournamentApi'
import { savedTeamsApi } from '../../../lib/accountApi'
import { askConfirm } from '../../../utils/askConfirm'
import {
  bracketSections, moveItem, parseSets, seedOrderOf, setsText, setsWinner
} from '../../../domain/beachTournament'
import {
  Button, Card, CardHeading, Field, Input, Select, SegmentedControl, RowList, Row, Chip, StatusPill,
  EmptyInset, SectionHeader, Notice, IconButton, toast
} from '../../../ui'
import { useDrawName, useSideLabel, useTournamentError } from './shared'

const GENDERS = ['women', 'men', 'mixed']
const MATCH_TONE = { scheduled: 'neutral', ready: 'planned', called: 'todo', in_progress: 'brand', finished: 'done', walkover: 'done', cancelled: 'neutral' }
const DRAW_TONE = { entries: 'neutral', seeded: 'neutral', drawn: 'planned', playing: 'brand', done: 'done' }
const KINDS = ['played', 'retired', 'forfeit', 'walkover']

function NewDrawModal({ open, tournamentId, onClose, onCreated }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const [form, setForm] = useState({ category: '', gender: 'women', slot_minutes: '50', rest_minutes: '0' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setError('') }
  const submit = async (e) => {
    e?.preventDefault()
    if (!form.category.trim() || busy) return
    setBusy(true)
    const res = await tournamentApi.createDraw(tournamentId, {
      category: form.category.trim(), gender: form.gender, format: 'DE',
      slot_minutes: Number(form.slot_minutes) || 50, rest_minutes: Number(form.rest_minutes) || 0
    })
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    onCreated(res.data.draw)
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={t('tournaments.newDraw')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="dark" size="lg" onClick={submit} loading={busy} disabled={!form.category.trim() || busy}>{t('tournaments.create')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.category')} hint={t('tournaments.categoryHint')}>
            <Input value={form.category} onChange={set('category')} maxLength={20} required autoFocus data-testid="draw-category" />
          </Field>
          <Field label={t('tournaments.gender')}>
            <Select value={form.gender} onChange={set('gender')} block options={GENDERS.map(g => ({ value: g, label: t(`tournaments.genders.${g}`) }))} />
          </Field>
        </div>
        <Field label={t('tournaments.format')}>
          <Input value={t('tournaments.formatDE')} disabled readOnly />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('tournaments.slotMinutes')}>
            <Input type="number" inputMode="numeric" min={10} max={240} value={form.slot_minutes} onChange={set('slot_minutes')} />
          </Field>
          <Field label={t('tournaments.restMinutes')}>
            <Input type="number" inputMode="numeric" min={0} max={240} value={form.rest_minutes} onChange={set('rest_minutes')} />
          </Field>
        </div>
        <InlineError error={error} />
      </form>
    </KitModal>
  )
}

const emptyPlayer = () => ({ first: '', last: '', licence: '', country: '' })

function AddEntryModal({ open, drawId, onClose, onAdded }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const [mode, setMode] = useState('saved')
  const [pairs, setPairs] = useState(null)
  const [teamId, setTeamId] = useState('')
  const [players, setPlayers] = useState([emptyPlayer(), emptyPlayer()])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setTeamId(''); setPlayers([emptyPlayer(), emptyPlayer()]); setName(''); setError('')
    let alive = true
    savedTeamsApi.fetchBundle({ sport: 'beach' }).then(res => {
      if (!alive) return
      const comps = new Map((res.data?.competitions || []).filter(c => !c.archived).map(c => [c.id, c]))
      const list = (res.data?.teams || []).filter(x => comps.has(x.competition_id))
        .map(x => ({ value: x.id, label: `${x.name} (${comps.get(x.competition_id).name})` }))
        .sort((a, b) => a.label.localeCompare(b.label))
      setPairs(list)
      if (!list.length) setMode('typed')
    })
    return () => { alive = false }
  }, [open])
  const setPlayer = (i, k) => (e) => {
    const v = e.target.value
    setPlayers(ps => ps.map((p, j) => (j === i ? { ...p, [k]: k === 'country' ? v.toUpperCase().slice(0, 3) : v } : p)))
    setError('')
  }
  const valid = mode === 'saved' ? !!teamId : players.every(p => p.last.trim())
  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const clean = (p) => ({ first: p.first.trim(), last: p.last.trim(), licence: p.licence.trim() || null, country: p.country.trim() || null })
    const body = mode === 'saved'
      ? { team_id: teamId }
      : { player1: clean(players[0]), player2: clean(players[1]), ...(name.trim() ? { name: name.trim() } : {}) }
    const res = await tournamentApi.addEntry(drawId, body)
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    onAdded()
    if (mode === 'saved') setTeamId('')
    else { setPlayers([emptyPlayer(), emptyPlayer()]); setName('') }
    toast.success(t('tournaments.pairAdded'))
  }
  return (
    <KitModal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={t('tournaments.addPair')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.close', 'Close')}</Button>
        <Button variant="dark" size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="entry-add">{t('tournaments.add')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <SegmentedControl
          ariaLabel={t('tournaments.addPair')}
          value={mode}
          onChange={setMode}
          options={[{ value: 'saved', label: t('tournaments.fromSaved') }, { value: 'typed', label: t('tournaments.typed') }]}
        />
        {mode === 'saved' ? (
          pairs && pairs.length === 0 ? <EmptyInset>{t('tournaments.noSavedPairs')}</EmptyInset> : (
            <Field label={t('tournaments.savedPair')}>
              <Select value={teamId} onChange={e => { setTeamId(e.target.value); setError('') }} block
                placeholder={t('tournaments.savedPairPlaceholder')} options={pairs || []} data-testid="entry-pair" />
            </Field>
          )
        ) : (
          <>
            {[0, 1].map(i => (
              <fieldset key={i} className="space-y-2">
                <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t(`tournaments.player${i + 1}`)}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('tournaments.lastName')}><Input value={players[i].last} onChange={setPlayer(i, 'last')} maxLength={80} required data-testid={`entry-last-${i + 1}`} /></Field>
                  <Field label={t('tournaments.firstName')}><Input value={players[i].first} onChange={setPlayer(i, 'first')} maxLength={80} /></Field>
                  <Field label={t('tournaments.licence')}><Input value={players[i].licence} onChange={setPlayer(i, 'licence')} maxLength={40} /></Field>
                  <Field label={t('tournaments.country')} hint={t('tournaments.countryHint')}>
                    <Input value={players[i].country} onChange={setPlayer(i, 'country')} maxLength={3} className="uppercase" />
                  </Field>
                </div>
              </fieldset>
            ))}
            <Field label={t('tournaments.pairName')} hint={t('tournaments.pairNameHint')}>
              <Input value={name} onChange={e => setName(e.target.value)} maxLength={120} />
            </Field>
          </>
        )}
        <InlineError error={error} />
      </form>
    </KitModal>
  )
}

function ResultModal({ match, entriesById, scoring, onClose, onSaved }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const side = useSideLabel(entriesById)
  const [kind, setKind] = useState('played')
  const [setsInput, setSetsInput] = useState('')
  const [winner, setWinner] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!match) return
    setKind(match.result || 'played')
    setSetsInput(setsText(match.sets))
    setWinner(match.winner_entry_id ? (match.winner_entry_id === match.entry1_id ? '1' : '2') : '')
    setError('')
  }, [match])
  if (!match) return null
  const sets = parseSets(setsInput)
  const fromSets = kind === 'played' && sets ? setsWinner(sets) : null
  const chosen = fromSets ? String(fromSets) : winner
  const valid = !!chosen && (kind === 'walkover' || sets !== null) && (kind !== 'played' || (sets && sets.length >= 2))
  const ended = match.status === 'finished' || match.status === 'walkover'
  const submit = async (e) => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const res = await tournamentApi.enterResult(match.id, { winner: Number(chosen), result: kind, sets: kind === 'walkover' ? null : (sets.length ? sets : null) })
    setBusy(false)
    if (res.error) return setError(errorText(res.error) + (res.error.details && typeof res.error.details === 'string' ? ` (${res.error.details})` : ''))
    toast.success(t('tournaments.resultSaved'))
    onSaved()
  }
  const withdraw = async () => {
    if (!(await askConfirm({
      title: t('tournaments.withdrawResultTitle', { n: match.game_n }),
      message: t('tournaments.withdrawResultBody'),
      confirmLabel: t('tournaments.withdrawResult'),
      tone: 'danger'
    }))) return
    setBusy(true)
    const res = await tournamentApi.withdrawResult(match.id)
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    onSaved()
  }
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      decision
      dismissible={false}
      title={t('tournaments.resultTitle', { n: match.game_n, code: match.code })}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={submit} loading={busy} disabled={!valid || busy} data-testid="result-save">{t('tournaments.saveResult')}</Button>
      </>}
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-stone-700">
          <span className="font-semibold">{side(match.entry1_id, match.source1)}</span>
          <span className="mx-1.5 text-stone-400">{t('tournaments.versus')}</span>
          <span className="font-semibold">{side(match.entry2_id, match.source2)}</span>
        </p>
        <Field label={t('tournaments.resultKind')}>
          <Select value={kind} onChange={e => { setKind(e.target.value); setError('') }} block
            options={KINDS.map(k => ({ value: k, label: t(`tournaments.kinds.${k}`) }))} />
        </Field>
        {kind !== 'walkover' && (
          <Field label={t('tournaments.sets')} hint={t('tournaments.setsHint', { points: (scoring?.points || [21, 21, 15]).join('/') })}
            error={sets === null ? t('tournaments.setsInvalid') : undefined}>
            <Input value={setsInput} onChange={e => { setSetsInput(e.target.value); setError('') }} placeholder="21:17 19:21 15:12"
              className="font-mono tabular-nums" inputMode="numeric" data-testid="result-sets" />
          </Field>
        )}
        <Field label={t('tournaments.winner')}>
          <SegmentedControl
            ariaLabel={t('tournaments.winner')}
            value={chosen}
            onChange={v => { if (!fromSets) setWinner(v) }}
            options={[{ value: '1', label: side(match.entry1_id, match.source1) }, { value: '2', label: side(match.entry2_id, match.source2) }]}
          />
        </Field>
        <InlineError error={error} />
        {ended && (
          <Button variant="danger-outline" size="sm" onClick={withdraw} disabled={busy}>{t('tournaments.withdrawResult')}</Button>
        )}
      </form>
    </KitModal>
  )
}

function EntriesCard({ draw, entries, edit, reload }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const open = draw.status === 'entries' || draw.status === 'seeded'
  const ordered = useMemo(() => seedOrderOf(entries), [entries])
  const [order, setOrder] = useState(() => ordered.map(e => e.id))
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setOrder(ordered.map(e => e.id)) }, [ordered])
  const byId = new Map(entries.map(e => [e.id, e]))
  const changed = order.some((id, i) => byId.get(id)?.seed !== i + 1)
  const others = entries.filter(e => e.status !== 'registered')

  const saveSeeds = async () => {
    setBusy(true)
    const res = await tournamentApi.putSeeds(draw.id, order)
    setBusy(false)
    if (res.error) return toast.error(errorText(res.error))
    toast.success(t('tournaments.seedsSaved'))
    reload()
  }
  const withdraw = async (e) => {
    if (!(await askConfirm({ title: t('tournaments.withdrawTitle', { name: e.name }), confirmLabel: t('tournaments.withdraw'), tone: 'danger' }))) return
    const res = await tournamentApi.updateEntry(e.id, { status: 'withdrawn', seed: null })
    if (res.error) return toast.error(errorText(res.error))
    reload()
  }
  const remove = async (e) => {
    if (!(await askConfirm({ title: t('tournaments.removeEntryTitle', { name: e.name }), confirmLabel: t('tournaments.remove'), tone: 'danger' }))) return
    const res = await tournamentApi.removeEntry(e.id)
    if (res.error) return toast.error(errorText(res.error))
    reload()
  }
  const players = (e) => [e.player1, e.player2].map(p => [p?.first, p?.last].filter(Boolean).join(' ')).filter(Boolean).join(' · ')

  return (
    <Card>
      <CardHeading
        title={t('tournaments.pairs')}
        hint={open && edit ? t('tournaments.seedsHint') : undefined}
        actions={open && edit && <>
          {changed && <Button variant="dark" size="sm" onClick={saveSeeds} loading={busy}>{t('tournaments.saveSeeds')}</Button>}
          <Button variant="ghost" size="sm" icon={Plus} onClick={() => setAdding(true)} data-testid="entry-new">{t('tournaments.addPair')}</Button>
        </>}
      />
      {order.length === 0 ? <EmptyInset>{t('tournaments.noPairs')}</EmptyInset> : (
        <RowList>
          {order.map((id, i) => {
            const e = byId.get(id)
            if (!e) return null
            return (
              <Row
                key={id}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                leading={<span className="w-8 shrink-0 pt-0.5 text-right text-sm font-bold tabular-nums text-stone-500">{open ? i + 1 : e.seed}</span>}
                title={e.name}
                meta={players(e)}
                chips={(e.final_rank || e.team_id) ? <>
                  {e.final_rank && <Chip tone="emerald">{t('tournaments.rankN', { n: e.final_rank })}</Chip>}
                  {e.team_id && <Chip>{t('tournaments.fromSavedChip')}</Chip>}
                </> : null}
                action={open && edit && (
                  <div className="flex items-center gap-1">
                    <IconButton label={t('tournaments.moveUp')} icon={ArrowUp} variant="subtle" disabled={i === 0} onClick={() => setOrder(o => moveItem(o, i, -1))} />
                    <IconButton label={t('tournaments.moveDown')} icon={ArrowDown} variant="subtle" disabled={i === order.length - 1} onClick={() => setOrder(o => moveItem(o, i, 1))} />
                    <IconButton label={t('tournaments.withdraw')} icon={UserMinus} variant="subtle" onClick={() => withdraw(e)} />
                    <IconButton label={t('tournaments.remove')} icon={Trash2} variant="subtle" onClick={() => remove(e)} />
                  </div>
                )}
              />
            )
          })}
        </RowList>
      )}
      {others.length > 0 && (
        <p className="mt-2 text-xs text-stone-500">{t('tournaments.withdrawnList')}: {others.map(e => e.name).join(', ')}</p>
      )}
      <AddEntryModal open={adding} drawId={draw.id} onClose={() => setAdding(false)} onAdded={reload} />
    </Card>
  )
}

function BracketCard({ draw, matches, entries, edit, reload }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const entriesById = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries])
  const side = useSideLabel(entriesById)
  const [resultFor, setResultFor] = useState(null)
  const [busy, setBusy] = useState(false)
  const sections = bracketSections(matches)
  const begun = matches.some(m => ['called', 'in_progress', 'finished', 'walkover'].includes(m.status) || m.match_id)

  const draw_ = async () => {
    setBusy(true)
    const preview = await tournamentApi.generate(draw.id, { dryRun: true })
    setBusy(false)
    if (preview.error) return toast.error(errorText(preview.error))
    const p = preview.data
    const warnings = (p.warnings || []).map(w => t(`tournaments.warnings.${w.code}`, w))
    const first = p.matches[0]?.game_n
    const last = p.matches[p.matches.length - 1]?.game_n
    if (!(await askConfirm({
      title: matches.length ? t('tournaments.regenerateTitle') : t('tournaments.generateTitle'),
      message: [t('tournaments.generateBody', { teams: p.teams, size: p.board_size, matches: p.matches.length, first, last }), ...warnings].join('\n\n'),
      confirmLabel: t('tournaments.generate')
    }))) return
    setBusy(true)
    const res = await tournamentApi.generate(draw.id)
    setBusy(false)
    if (res.error) return toast.error(errorText(res.error))
    toast.success(t('tournaments.generated'))
    reload()
  }
  const reset = async () => {
    if (!(await askConfirm({ title: t('tournaments.resetTitle'), message: t('tournaments.resetBody'), confirmLabel: t('tournaments.reset'), tone: 'danger' }))) return
    const res = await tournamentApi.resetBracket(draw.id)
    if (res.error) return toast.error(errorText(res.error))
    reload()
  }

  return (
    <Card>
      <CardHeading
        title={t('tournaments.bracket')}
        actions={edit && !begun && <>
          {matches.length > 0 && <Button variant="danger-outline" size="sm" onClick={reset}>{t('tournaments.reset')}</Button>}
          <Button variant={matches.length ? 'ghost' : 'primary'} size="sm" icon={Shuffle} onClick={draw_} loading={busy} data-testid="bracket-generate">
            {matches.length ? t('tournaments.regenerate') : t('tournaments.generate')}
          </Button>
        </>}
      />
      {matches.length === 0 ? <EmptyInset>{t('tournaments.noBracket')}</EmptyInset> : (
        <div className="space-y-4">
          {sections.map(sec => (
            <div key={`${sec.phase}-${sec.round}`}>
              <SectionHeader
                title={`${t(`tournaments.phases.${sec.phase}`)} · ${t('tournaments.roundN', { n: sec.index })}`}
                count={sec.matches.length}
              />
              <RowList>
                {sec.matches.map(m => {
                  const ended = m.status === 'finished' || m.status === 'walkover'
                  const won = (id) => ended && m.winner_entry_id === id
                  const canEnter = edit && m.entry1_id && m.entry2_id && !m.match_id
                  return (
                    <Row
                      key={m.id}
                      stripe={false}
                      toolsIndent="sm:pl-2"
                      actionIndent="pl-1.5"
                      leading={<span className="w-14 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-stone-500">#{m.game_n} {m.code}</span>}
                      title={<p className="break-words text-sm text-stone-900">
                        {/* phones: one pair per line; from sm: "A vs B" */}
                        <span className={`block sm:inline ${won(m.entry1_id) ? 'font-bold' : 'font-medium'}`}>{side(m.entry1_id, m.source1)}</span>
                        <span className="mx-1.5 hidden text-stone-400 sm:inline">{t('tournaments.versus')}</span>
                        <span className={`block sm:inline ${won(m.entry2_id) ? 'font-bold' : 'font-medium'}`}>{side(m.entry2_id, m.source2)}</span>
                      </p>}
                      meta={ended ? <span className="font-mono tabular-nums">{m.result === 'walkover' ? t('tournaments.kinds.walkover') : setsText(m.sets)}{m.result && m.result !== 'played' && m.result !== 'walkover' ? ` · ${t(`tournaments.kinds.${m.result}`)}` : ''}</span> : null}
                      status={<StatusPill tone={MATCH_TONE[m.status] || 'neutral'}>{t(`tournaments.matchStatus.${m.status}`)}</StatusPill>}
                      action={canEnter && (
                        <Button variant="ghost" size="sm" onClick={() => setResultFor(m)} data-testid={`result-${m.code}`}>
                          {ended ? t('tournaments.correctResult') : t('tournaments.enterResult')}
                        </Button>
                      )}
                    />
                  )
                })}
              </RowList>
            </div>
          ))}
        </div>
      )}
      {resultFor && (
        <ResultModal
          match={resultFor}
          entriesById={entriesById}
          scoring={draw.scoring}
          onClose={() => setResultFor(null)}
          onSaved={() => { setResultFor(null); reload() }}
        />
      )}
    </Card>
  )
}

function DrawPanel({ draw, bundle, reload, onBack }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const drawName = useDrawName()
  const edit = bundle.tournament.can_edit
  const entries = bundle.entries.filter(e => e.draw_id === draw.id)
  const matches = bundle.matches.filter(m => m.draw_id === draw.id)
  const remove = async () => {
    if (!(await askConfirm({ title: t('tournaments.deleteDrawTitle', { name: drawName(draw) }), message: t('tournaments.deleteDrawBody'), confirmLabel: t('tournaments.deleteDraw'), tone: 'danger' }))) return
    const res = await tournamentApi.removeDraw(draw.id)
    if (res.error) return toast.error(errorText(res.error))
    onBack()
    reload()
  }
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Button variant="text" icon={ArrowLeft} onClick={onBack}>{t('tournaments.allDraws')}</Button>
        {edit && <Button variant="danger-outline" size="sm" icon={Trash2} onClick={remove}>{t('tournaments.deleteDraw')}</Button>}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-lg font-bold text-stone-900">{drawName(draw)}</h2>
        <StatusPill tone={DRAW_TONE[draw.status] || 'neutral'}>{t(`tournaments.drawStatus.${draw.status}`)}</StatusPill>
        <span className="text-xs text-stone-500">{t('tournaments.formatDE')} · {t('tournaments.slotRest', { slot: draw.slot_minutes, rest: draw.rest_minutes })}</span>
      </div>
      <EntriesCard draw={draw} entries={entries} edit={edit} reload={reload} />
      <BracketCard draw={draw} matches={matches} entries={entries} edit={edit} reload={reload} />
    </div>
  )
}

/** The draws of a tournament (one category and gender each), then one draw. */
export default function DrawsSection({ bundle, reload }) {
  const { t } = useTranslation()
  const drawName = useDrawName()
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const edit = bundle.tournament.can_edit
  const open = bundle.draws.find(d => d.id === openId)
  if (open) return <DrawPanel draw={open} bundle={bundle} reload={reload} onBack={() => setOpenId(null)} />
  return (
    <Card>
      <CardHeading
        title={t('tournaments.sections.draws')}
        actions={edit && <Button variant="ghost" size="sm" icon={Plus} onClick={() => setCreating(true)} data-testid="draw-new">{t('tournaments.newDraw')}</Button>}
      />
      {bundle.draws.length === 0 ? <EmptyInset>{t('tournaments.noDraws')}</EmptyInset> : (
        <RowList>
          {bundle.draws.map(d => {
            const n = bundle.entries.filter(e => e.draw_id === d.id && e.status === 'registered').length
            return (
              <Row
                key={d.id}
                stripe={false}
                title={drawName(d)}
                meta={<span className="tabular-nums">{t('tournaments.pairsCount', { count: n })}</span>}
                status={<StatusPill tone={DRAW_TONE[d.status] || 'neutral'}>{t(`tournaments.drawStatus.${d.status}`)}</StatusPill>}
                onOpen={() => setOpenId(d.id)}
                label={drawName(d)}
              />
            )
          })}
        </RowList>
      )}
      {bundle.draws.length > 0 && bundle.courts.length === 0 && <Notice tone="warning" className="mt-3">{t('tournaments.errors.noCourts')}</Notice>}
      <NewDrawModal
        open={creating}
        tournamentId={bundle.tournament.id}
        onClose={() => setCreating(false)}
        onCreated={(d) => { setCreating(false); reload(); setOpenId(d.id) }}
      />
    </Card>
  )
}
