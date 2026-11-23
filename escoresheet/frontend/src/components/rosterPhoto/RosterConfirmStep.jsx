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
 */

const CELL = 'h-10 w-full min-w-0 rounded-md border bg-white px-2 text-sm text-stone-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
const LEVEL = {
  invalid: 'border-red-500 bg-red-50',
  low: 'border-amber-400 bg-amber-50'
}

function issueProps (issue, t) {
  if (!issue) return { className: 'border-stone-300' }
  return {
    className: LEVEL[issue.level],
    title: t(`rosterPhoto.issue.${issue.reason}`),
    'aria-invalid': issue.level === 'invalid' || undefined,
    'data-issue': issue.level
  }
}

function TextCell ({ value, onChange, issue, label, inputMode, maxLength, className, testId }) {
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
      autoComplete="off"
      spellCheck={false}
      {...extra}
      className={cn(CELL, extra.className, className)}
      data-testid={testId}
    />
  )
}

function MarkCell ({ checked, onChange, issue, label, letter, testId }) {
  const { t } = useTranslation()
  const extra = issueProps(issue, t)
  return (
    <label className={cn('flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border text-sm font-bold', checked ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-300 bg-white text-stone-400', issue && extra.className, issue && checked && 'text-stone-900')} title={extra.title || label}>
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
    <div className="space-y-3" data-sensitive="">
      <p className="m-0 text-xs text-stone-500" data-testid="roster-photo-method">
        {[t('rosterPhoto.confirm.method'), fromSaved ? t('rosterPhoto.confirm.fromSaved', { count: fromSaved }) : null].filter(Boolean).join(' · ')}
      </p>
      {(toFix > 0 || toCheck > 0) && (
        <Banner tone={toFix > 0 ? 'danger' : 'warning'} data-testid="roster-photo-issues">
          {[toFix ? t('rosterPhoto.confirm.toFix', { count: toFix }) : null, toCheck ? t('rosterPhoto.confirm.toCheck', { count: toCheck }) : null].filter(Boolean).join(' · ')}
        </Banner>
      )}

      <h3 className="m-0 text-sm font-semibold text-stone-800">{t('rosterPhoto.confirm.players', { count: players.length })}</h3>
      {players.length === 0
        ? <p className="m-0 text-sm text-stone-500">{t('rosterPhoto.confirm.empty')}</p>
        : (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[34rem] border-separate border-spacing-x-1 border-spacing-y-1 text-left" data-testid="roster-photo-players">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  <th className="w-14 font-semibold">{t('rosterPhoto.col.number')}</th>
                  <th className="font-semibold">{t('rosterPhoto.col.lastName')}</th>
                  <th className="font-semibold">{t('rosterPhoto.col.firstName')}</th>
                  <th className="w-28 font-semibold">{t('rosterPhoto.col.licence')}</th>
                  <th className="w-10 text-center font-semibold" title={t('rosterPhoto.col.captainLong')}>{t('rosterPhoto.col.captain')}</th>
                  <th className="w-10 text-center font-semibold" title={t('rosterPhoto.col.liberoLong')}>{t('rosterPhoto.col.libero')}</th>
                  <th className="w-10"><span className="sr-only">{t('rosterPhoto.confirm.remove')}</span></th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => {
                  const m = issues.players[i] || {}
                  const who = [p.lastName, p.firstName].filter(Boolean).join(' ')
                  return (
                    <tr key={i} data-testid="roster-photo-row">
                      <td><TextCell value={numberText(p.number)} onChange={(v) => setPlayer(i, { number: numberOf(v) })} issue={m.number} label={`${t('rosterPhoto.col.number')} ${who}`} inputMode="numeric" maxLength={2} className="text-center tabular-nums" testId="roster-photo-number" /></td>
                      <td><TextCell value={p.lastName} onChange={(v) => setPlayer(i, { lastName: v })} issue={m.lastName} label={`${t('rosterPhoto.col.lastName')} ${i + 1}`} testId="roster-photo-last" /></td>
                      <td><TextCell value={p.firstName} onChange={(v) => setPlayer(i, { firstName: v })} issue={m.firstName} label={`${t('rosterPhoto.col.firstName')} ${i + 1}`} testId="roster-photo-first" /></td>
                      <td><TextCell value={p.licence} onChange={(v) => setPlayer(i, { licence: v.replace(/\D/g, '') })} issue={m.licence} label={`${t('rosterPhoto.col.licence')} ${who}`} inputMode="numeric" maxLength={6} className="tabular-nums" testId="roster-photo-licence" /></td>
                      <td><MarkCell checked={p.isCaptain} onChange={(v) => setPlayer(i, { isCaptain: v })} issue={m.isCaptain} label={`${t('rosterPhoto.col.captainLong')} ${who}`} letter={t('rosterPhoto.col.captain')} testId="roster-photo-captain" /></td>
                      <td><MarkCell checked={p.isLibero} onChange={(v) => setPlayer(i, { isLibero: v })} issue={m.isLibero} label={`${t('rosterPhoto.col.liberoLong')} ${who}`} letter={t('rosterPhoto.col.libero')} testId="roster-photo-libero" /></td>
                      <td>
                        <button type="button" onClick={() => removePlayer(i)} className="flex h-10 w-10 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-red-600" aria-label={`${t('rosterPhoto.confirm.remove')} ${who}`} data-testid="roster-photo-remove">
                          <Trash2 size={16} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
      <Button variant="secondary" size="md" icon={Plus} onClick={addPlayer} data-testid="roster-photo-add">{t('rosterPhoto.confirm.add')}</Button>

      <h3 className="m-0 text-sm font-semibold text-stone-800">{t('rosterPhoto.confirm.officials')}</h3>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[34rem] border-separate border-spacing-x-1 border-spacing-y-1 text-left" data-testid="roster-photo-officials">
          <tbody>
            {OFFICIAL_KEYS.map((k) => {
              const o = roster[k] || { firstName: '', lastName: '', licence: '' }
              const m = issues.officials[k] || {}
              const role = t(`rosterPhoto.role.${k}`)
              return (
                <tr key={k} data-testid={`roster-photo-official-${k}`}>
                  <td className="w-28 text-xs font-semibold text-stone-600">{role}</td>
                  <td><TextCell value={o.lastName} onChange={(v) => setOfficial(k, { lastName: v })} issue={m.lastName} label={`${role} ${t('rosterPhoto.col.lastName')}`} /></td>
                  <td><TextCell value={o.firstName} onChange={(v) => setOfficial(k, { firstName: v })} issue={m.firstName} label={`${role} ${t('rosterPhoto.col.firstName')}`} /></td>
                  <td className="w-28"><TextCell value={o.licence} onChange={(v) => setOfficial(k, { licence: v.replace(/\D/g, '') })} issue={m.licence} label={`${role} ${t('rosterPhoto.col.licence')}`} inputMode="numeric" maxLength={7} className="tabular-nums" /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
