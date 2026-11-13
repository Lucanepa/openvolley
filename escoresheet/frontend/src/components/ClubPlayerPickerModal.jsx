import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserPlus } from 'lucide-react'
import KitModal from './manage/KitModal'
import { normalizeName } from '../domain/savedTeams'
import { Button, Checkbox, Chip, EmptyInset, Field, SearchInput, Select, cn, dayLabel } from '../ui'

const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')
const LISTS = ['players', 'scorers', 'coaches']
// The server's name search (`search`): from this many characters, after a short pause
export const SEARCH_MIN_LENGTH = 3
const SEARCH_DELAY_MS = 300
const matches = (p, needle) => !needle || fold(`${p.last_name} ${p.first_name || ''} ${p.first_name || ''} ${p.last_name} ${p.sv_number}`).includes(needle)

/**
 * "Add from club" (db/024, docs/club-licences-spec.md): people of the club's
 * licence lists, found by name or licence number. Used by the manager's My
 * teams and by Match Setup (an offline copy there).
 *
 * mode 'players' (default): `players` are the people offered (the caller
 * gives the players list, of the team's gender only); several at once;
 * `isTaken(person)` marks one already in the roster. onPick(people).
 *
 * mode 'officials': `players` is everyone of the club's lists (with their
 * `lists`), of either gender (owner 2026-11-09: an official may be anyone of
 * the club). One person for one role of `roles` ([{ value, label }],
 * starting at `initialRole`); `rolesOf(person)` gives the roles the person
 * holds already (the chosen one is shown as already there),
 * `holderOf(role)` the name of the one holding the role now (the choice takes
 * the role). onPick([person], role).
 *
 * mode 'link' (owner 2026-11-10: someone typed by hand "can be linked lately"):
 * one person of `players` for one row, the search starting at `initialQuery`
 * (empty when that finds nobody: a typo). onPick([person]).
 *
 * `search(q)` (owner decision 2: a team manager never gets the club's whole
 * lists): the server's name search ({ people, more }, or the API answer with
 * them in data), asked from SEARCH_MIN_LENGTH characters on; its people are
 * offered after those of `players` that match.
 * `resolve(people)`: what the chosen people become before onPick (Match
 * Setup: the dates of birth the tablet's copy leaves out, asked for the
 * chosen ones only); the people as they are when it fails.
 *
 * A person is { sv_number, last_name, first_name, dob, gender, lists? }.
 */
export default function ClubPlayerPickerModal({ open, ...rest }) {
  if (!open) return null
  return <PickerBody {...rest} />
}

function PickerBody({ onClose, onPick, players = [], title, isTaken = () => false, zIndex, mode = 'players', roles = [], initialRole = null, rolesOf = () => [], holderOf = () => null, initialQuery = '', search = null, resolve = null }) {
  const { t } = useTranslation()
  const officials = mode === 'officials'
  const link = mode === 'link'
  // officials and link: one person
  const single = officials || link
  // the row's name as typed; a typo that finds nobody starts with everyone
  // (with the server's search, the name is looked up there too)
  const [q, setQ] = useState(() => (initialQuery && (search || players.some((p) => matches(p, fold(initialQuery)))) ? initialQuery : ''))
  const [chosen, setChosen] = useState(() => new Set())
  const [role, setRole] = useState(() => (roles.some((r) => r.value === initialRole) ? initialRole : roles[0]?.value ?? null))
  const [found, setFound] = useState({ q: '', people: [], more: false, loading: false })
  const [busy, setBusy] = useState(false)
  const seen = useRef(new Map())
  const roleLabel = (v) => roles.find((r) => r.value === v)?.label || v || ''
  const needle = fold(q)
  const searching = !!search && needle.length >= SEARCH_MIN_LENGTH
  useEffect(() => {
    if (!searching) return undefined
    let live = true
    setFound((f) => ({ ...f, loading: true }))
    const timer = setTimeout(async () => {
      let people = []
      let more = false
      try {
        const r = await search(q.trim())
        const d = r?.data ?? r
        people = Array.isArray(d?.people) ? d.people.filter((p) => p && p.sv_number != null) : []
        more = d?.more === true
      } catch { /* offline: the local ones only */ }
      if (!live) return
      // the ones found stay pickable when the search goes on
      for (const p of people) seen.current.set(p.sv_number, p)
      setFound({ q: needle, people, more, loading: false })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [searching, needle]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const local = players.filter((p) => matches(p, needle))
    if (!searching || found.q !== needle) return local
    const have = new Set(local.map((p) => String(p.sv_number)))
    return [...local, ...found.people.filter((p) => !have.has(String(p.sv_number)))]
  }, [players, needle, searching, found])
  // players: several at once; officials: one person for the role
  const toggle = (sv, on) => setChosen((cur) => {
    const next = new Set(single ? [] : cur)
    if (on) next.add(sv)
    else next.delete(sv)
    return next
  })
  const pick = async () => {
    // in the order offered: those of `players`, then those the search found
    const local = new Set(players.map((p) => p.sv_number))
    let out = [...players.filter((p) => chosen.has(p.sv_number)), ...[...chosen].filter((sv) => !local.has(sv)).map((sv) => seen.current.get(sv)).filter(Boolean)]
    if (!out.length || busy) return
    if (resolve) {
      setBusy(true)
      try {
        out = (await resolve(out)) || out
      } catch { /* the people as they are */ }
      setBusy(false)
    }
    if (officials) onPick(out.slice(0, 1), role)
    else if (link) onPick(out.slice(0, 1))
    else onPick(out)
  }
  const holder = officials && role ? holderOf(role) : null
  const meta = (p) => [
    p.dob ? dayLabel(p.dob, { year: true }) : null,
    t('clubPlayers.licence', { number: p.sv_number }),
    single && Array.isArray(p.lists) && p.lists.length ? p.lists.filter((l) => LISTS.includes(l)).map((l) => t(`manage.licences.lists.${l}`)).join(', ') : null
  ].filter(Boolean).join(' · ')
  return (
    <KitModal
      open
      zIndex={zIndex}
      onClose={onClose}
      size="lg"
      icon={UserPlus}
      title={title || t(officials ? 'clubPlayers.officialTitle' : link ? 'clubPlayers.linkTitle' : 'clubPlayers.title')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" disabled={chosen.size === 0 || (officials && !role)} loading={busy} onClick={pick} data-testid="club-picker-add">
          {officials ? t('clubPlayers.addAs', { role: roleLabel(role) }) : link ? t('clubPlayers.link') : t('clubPlayers.addCount', { count: chosen.size })}
        </Button>
      </>}
    >
      <div className="space-y-3" data-testid="club-picker" data-mode={mode}>
        {officials && roles.length > 0 && (
          <Field label={t('clubPlayers.role')} hint={holder ? t('clubPlayers.roleNow', { name: holder }) : undefined}>
            <Select value={role || ''} onChange={(e) => { setRole(e.target.value); setChosen(new Set()) }} data-testid="club-picker-role">
              {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </Field>
        )}
        {players.length === 0 && !search ? (
          <EmptyInset>{t(single ? 'clubPlayers.nonePeople' : 'clubPlayers.none')}</EmptyInset>
        ) : (
          <>
            <SearchInput size="md" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('clubPlayers.search')} aria-label={t('clubPlayers.search')} data-testid="club-picker-search" />
            {search && !searching && <p className="m-0 text-xs text-stone-500" data-testid="club-picker-search-hint">{t('clubPlayers.searchHint', { count: SEARCH_MIN_LENGTH })}</p>}
            {searching && found.q === needle && found.more && <p className="m-0 text-xs text-stone-500" data-testid="club-picker-search-more">{t('clubPlayers.searchMore')}</p>}
            {list.length === 0 ? (
              searching && (found.loading || found.q !== needle)
                ? <EmptyInset>{t('clubPlayers.searching')}</EmptyInset>
                : <EmptyInset>{t(single ? 'clubPlayers.noMatchPeople' : 'clubPlayers.noMatch')}</EmptyInset>
            ) : (
              <ul
                className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white"
                role={single ? 'radiogroup' : undefined}
                aria-label={officials ? roleLabel(role) : link ? t('clubPlayers.linkTitle') : undefined}
              >
                {list.map((p) => {
                  const name = <span className="font-medium text-stone-900 [overflow-wrap:anywhere]">{p.last_name} {p.first_name || ''}</span>
                  if (!single) {
                    const taken = isTaken(p)
                    return (
                      <li key={p.sv_number} className="flex items-center gap-2 px-3 py-2" data-testid="club-picker-row">
                        <Checkbox
                          checked={taken || chosen.has(p.sv_number)}
                          disabled={taken}
                          onChange={(e) => toggle(p.sv_number, e.target.checked)}
                          label={name}
                          hint={meta(p)}
                          className="min-w-0 flex-1"
                        />
                        {taken && <Chip>{t('clubPlayers.inRoster')}</Chip>}
                      </li>
                    )
                  }
                  // the one already in the chosen role is shown as there; other roles as chips
                  const held = officials ? rolesOf(p) || [] : []
                  const inRole = officials && !!role && held.includes(role)
                  return (
                    <li key={p.sv_number} className="flex items-center gap-2 px-3 py-2" data-testid="club-picker-row">
                      <label className={cn('flex min-w-0 flex-1 cursor-pointer items-start gap-3', inRole && 'cursor-default opacity-50')}>
                        <input
                          type="radio"
                          name="club-official"
                          checked={!inRole && chosen.has(p.sv_number)}
                          disabled={inRole}
                          onChange={(e) => toggle(p.sv_number, e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-stone-700">{name}</span>
                          <span className="block text-xs text-stone-400">{meta(p)}</span>
                        </span>
                      </label>
                      {inRole
                        ? <Chip>{t('clubPlayers.inRole')}</Chip>
                        : held.map((r) => <Chip key={r}>{roleLabel(r)}</Chip>)}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </KitModal>
  )
}
