import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Button } from '../../ui'
import { cn } from '../../ui/cn.js'
import { OFFICIAL_KEYS } from '../../domain/importedRoster'

/**
 * The rows a photo gave, every field editable before anything is applied:
 * players (number, last and first name, SV number, captain, libero) and the
 * coach and assistants. issues: domain/importedRoster fieldIssues; a field in
 * red must be fixed, one in amber checked. Nothing here writes anywhere:
 * onChange hands the edited roster back.
 *
 * Fits its dialog without scrolling sideways (owner, 2026-11-27: a Galaxy Tab
 * A7 Lite with a large system font, 1340 x 800): each row is a grid of its
 * own, one line where the dialog is wide enough, two lines below that (the
 * number and the names, then the SV number and the marks), and a name wraps
 * onto a second line in its box instead of being cut off. Every control is
 * 44 px high.
 */

const FIELD = 'block w-full min-w-0 rounded-md border bg-white px-2 text-sm text-stone-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
const LEVEL = {
  invalid: 'border-red-500 bg-red-50',
  low: 'border-amber-400 bg-amber-50'
}
// one line per row from this width of the dialog (42rem; below it two lines)
const PLAYER_ROW = 'grid grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-1 @2xl:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)_7rem_8.75rem]'
const OFFICIAL_ROW = 'grid grid-cols-2 items-start gap-1 @2xl:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_7rem]'
const HEAD = 'text-[11px] font-semibold uppercase tracking-wide text-stone-500'
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

function issueProps (issue, t) {
  if (!issue) return { className: 'border-stone-300' }
  return {
    className: LEVEL[issue.level],
    title: t(`rosterPhoto.issue.${issue.reason}`),
    'aria-invalid': issue.level === 'invalid' || undefined,
    'data-issue': issue.level
  }
}

function TextCell ({ value, onChange, issue, label, placeholder = label, inputMode, maxLength, className, testId }) {
  const { t } = useTranslation()
  const extra = issueProps(issue, t)
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={inputMode}
      maxLength={maxLength}
      aria-label={label}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      {...extra}
      className={cn(FIELD, 'h-11 placeholder:text-stone-300', extra.className, className)}
      data-testid={testId}
    />
  )
}

/**
 * A name: a text box that grows a line when the name does not fit (a long
 * name stays whole on a narrow dialog or with a large font), never a line
 * break of its own (Enter does nothing, a pasted break becomes a space).
 */
function NameCell ({ value, onChange, issue, label, placeholder = label, testId }) {
  const { t } = useTranslation()
  const extra = issueProps(issue, t)
  const ref = useRef(null)
  // as high as its text: CSS field-sizing where the browser has it (Chrome,
  // the Android WebView), else measured here (Safari)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || FIELD_SIZING) return undefined
    const fit = () => { el.style.height = 'auto'; el.style.height = `${Math.max(44, el.scrollHeight + 2)}px` }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    let width = el.clientWidth
    const watch = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit() } })
    watch.observe(el)
    return () => watch.disconnect()
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
      aria-label={label}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      {...extra}
      className={cn(FIELD, 'min-h-11 resize-none overflow-hidden py-2.5 leading-snug break-words [field-sizing:content] placeholder:text-stone-300', extra.className)}
      data-testid={testId}
    />
  )
}

function MarkCell ({ checked, onChange, issue, label, letter, testId }) {
  const { t } = useTranslation()
  const extra = issueProps(issue, t)
  return (
    <label className={cn('flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border text-sm font-bold', checked ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-300 bg-white text-stone-400', issue && extra.className, issue && checked && 'text-stone-900')} title={extra.title || label}>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} aria-invalid={extra['aria-invalid']} data-testid={testId} />
      {letter}
    </label>
  )
}

const numberText = (n) => (Number.isInteger(n) ? String(n) : '')
const numberOf = (text) => {
  const digits = String(text).replace(/\D/g, '').slice(0, 2)
  return digits ? Number(digits) : null
}

export default function RosterConfirmStep ({ roster, issues, onChange }) {
  const { t } = useTranslation()
  const players = roster.players || []
  const setPlayer = (i, patch) => onChange({ ...roster, players: players.map((p, k) => (k === i ? { ...p, ...patch } : p)) })
  const removePlayer = (i) => onChange({ ...roster, players: players.filter((_, k) => k !== i) })
  // a row the photo did not give (missed, or not on it)
  const addPlayer = () => onChange({ ...roster, players: [...players, { number: null, licence: '', firstName: '', lastName: '', dob: '', isLfp: false, isCaptain: false, isLibero: false }] })
  const setOfficial = (key, patch) => {
    const prev = roster[key] || { firstName: '', lastName: '', licence: '' }
    onChange({ ...roster, [key]: { ...prev, ...patch } })
  }

  const count = (level) => [...issues.players, ...Object.values(issues.officials)]
    .reduce((n, m) => n + Object.values(m).filter((x) => x.level === level).length, 0)
  const toFix = count('invalid')
  const toCheck = count('low')
  const fromSaved = players.filter((p) => p.fromSavedTeam).length

  return (
    <div className="@container space-y-3" data-sensitive="">
      <p className="m-0 text-xs text-stone-500" data-testid="roster-photo-method">
        {[t('rosterPhoto.confirm.method'), fromSaved ? t('rosterPhoto.confirm.fromSaved', { count: fromSaved }) : null].filter(Boolean).join(' · ')}
      </p>
      {roster.struck?.length > 0 && (
        // rows struck out on the list: not playing, never applied (named so the scorer knows)
        <Banner tone="info" data-testid="roster-photo-struck">
          {t('rosterPhoto.confirm.struck', { count: roster.struck.length, names: roster.struck.map((p) => [p.lastName, p.firstName].filter(Boolean).join(' ') || p.licence).join(', ') })}
        </Banner>
      )}
      {(toFix > 0 || toCheck > 0) && (
        <Banner tone={toFix > 0 ? 'danger' : 'warning'} data-testid="roster-photo-issues">
          {[toFix ? t('rosterPhoto.confirm.toFix', { count: toFix }) : null, toCheck ? t('rosterPhoto.confirm.toCheck', { count: toCheck }) : null].filter(Boolean).join(' · ')}
        </Banner>
      )}

      <h3 className="m-0 text-sm font-semibold text-stone-800">{t('rosterPhoto.confirm.players', { count: players.length })}</h3>
      {players.length === 0
        ? <p className="m-0 text-sm text-stone-500">{t('rosterPhoto.confirm.empty')}</p>
        : (
          <div role="table" className="space-y-1" data-testid="roster-photo-players">
            {/* column names, where a row is one line */}
            <div role="row" className={cn(PLAYER_ROW, 'hidden @2xl:grid')}>
              <span role="columnheader" className={HEAD}>{t('rosterPhoto.col.number')}</span>
              <span role="columnheader" className={HEAD}>{t('rosterPhoto.col.lastName')}</span>
              <span role="columnheader" className={HEAD}>{t('rosterPhoto.col.firstName')}</span>
              <span role="columnheader" className={HEAD}>{t('rosterPhoto.col.licence')}</span>
              <span role="columnheader" className={cn(HEAD, 'sr-only')}>{t('rosterPhoto.col.captainLong')} · {t('rosterPhoto.col.liberoLong')}</span>
            </div>
            {players.map((p, i) => {
              const m = issues.players[i] || {}
              const who = [p.lastName, p.firstName].filter(Boolean).join(' ')
              return (
                <div role="row" key={i} className={cn(PLAYER_ROW, 'border-t border-stone-100 pt-1 first:border-t-0 first:pt-0 @2xl:border-t-0 @2xl:pt-0')} data-testid="roster-photo-row">
                  <div role="cell"><TextCell value={numberText(p.number)} onChange={(v) => setPlayer(i, { number: numberOf(v) })} issue={m.number} label={`${t('rosterPhoto.col.number')} ${who}`} placeholder="" inputMode="numeric" maxLength={2} className="px-1 text-center tabular-nums" testId="roster-photo-number" /></div>
                  <div role="cell"><NameCell value={p.lastName} onChange={(v) => setPlayer(i, { lastName: v })} issue={m.lastName} label={`${t('rosterPhoto.col.lastName')} ${i + 1}`} placeholder={t('rosterPhoto.col.lastName')} testId="roster-photo-last" /></div>
                  <div role="cell"><NameCell value={p.firstName} onChange={(v) => setPlayer(i, { firstName: v })} issue={m.firstName} label={`${t('rosterPhoto.col.firstName')} ${i + 1}`} placeholder={t('rosterPhoto.col.firstName')} testId="roster-photo-first" /></div>
                  <div role="cell" className="col-span-2 @2xl:col-span-1"><TextCell value={p.licence} onChange={(v) => setPlayer(i, { licence: v.replace(/\D/g, '') })} issue={m.licence} label={`${t('rosterPhoto.col.licence')} ${who}`} placeholder={t('rosterPhoto.col.licence')} inputMode="numeric" maxLength={6} className="tabular-nums" testId="roster-photo-licence" /></div>
                  <div role="cell" className="flex justify-end gap-1">
                    <MarkCell checked={p.isCaptain} onChange={(v) => setPlayer(i, { isCaptain: v })} issue={m.isCaptain} label={`${t('rosterPhoto.col.captainLong')} ${who}`} letter={t('rosterPhoto.col.captain')} testId="roster-photo-captain" />
                    <MarkCell checked={p.isLibero} onChange={(v) => setPlayer(i, { isLibero: v })} issue={m.isLibero} label={`${t('rosterPhoto.col.liberoLong')} ${who}`} letter={t('rosterPhoto.col.libero')} testId="roster-photo-libero" />
                    <button type="button" onClick={() => removePlayer(i)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60" aria-label={`${t('rosterPhoto.confirm.remove')} ${who}`} title={`${t('rosterPhoto.confirm.remove')} ${who}`} data-testid="roster-photo-remove">
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          )}
      <Button variant="secondary" size="md" icon={Plus} onClick={addPlayer} data-testid="roster-photo-add">{t('rosterPhoto.confirm.add')}</Button>

      <h3 className="m-0 text-sm font-semibold text-stone-800">{t('rosterPhoto.confirm.officials')}</h3>
      <div role="table" className="space-y-2 @2xl:space-y-1" data-testid="roster-photo-officials">
        {OFFICIAL_KEYS.map((k) => {
          const o = roster[k] || { firstName: '', lastName: '', licence: '' }
          const m = issues.officials[k] || {}
          const role = t(`rosterPhoto.role.${k}`)
          return (
            <div role="row" key={k} className={OFFICIAL_ROW} data-testid={`roster-photo-official-${k}`}>
              <div role="rowheader" className="col-span-2 self-center text-xs font-semibold text-stone-600 @2xl:col-span-1">{role}</div>
              <div role="cell"><NameCell value={o.lastName} onChange={(v) => setOfficial(k, { lastName: v })} issue={m.lastName} label={`${role} ${t('rosterPhoto.col.lastName')}`} placeholder={t('rosterPhoto.col.lastName')} /></div>
              <div role="cell"><NameCell value={o.firstName} onChange={(v) => setOfficial(k, { firstName: v })} issue={m.firstName} label={`${role} ${t('rosterPhoto.col.firstName')}`} placeholder={t('rosterPhoto.col.firstName')} /></div>
              <div role="cell" className="col-span-2 @2xl:col-span-1"><TextCell value={o.licence} onChange={(v) => setOfficial(k, { licence: v.replace(/\D/g, '') })} issue={m.licence} label={`${role} ${t('rosterPhoto.col.licence')}`} placeholder={t('rosterPhoto.col.licence')} inputMode="numeric" maxLength={7} className="tabular-nums" /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
