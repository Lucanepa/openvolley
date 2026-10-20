import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import TeamShirt from './TeamShirt'
import TeamColourPicker from './TeamColourPicker'
import { Button, Field, Input, cn, FOCUS_RING, backdropDismiss } from '../ui'
import { DEFAULT_AWAY_COLOUR, DEFAULT_HOME_COLOUR } from '../utils/teamColours'
import { defaultShortName } from '../domain/easyMatch'

/**
 * The few things an easy match needs before the coin toss: the two teams
 * (name, short name, shirt colour) and the format. No rosters, officials or
 * signatures: shirt numbers come with the line-ups (domain/easyMatch.js).
 *
 * `prefill` (domain/easyMatch.js easyMatchPrefill) comes from the page address
 * when another program opens OpenVolley on its game.
 */
export default function EasyMatchModal({ open, prefill = null, busy = false, onCancel, onStart }) {
  const { t } = useTranslation()
  const [teams, setTeams] = useState(() => ({
    home: {
      name: prefill?.homeName || '',
      short: prefill?.homeShort || '',
      color: prefill?.homeColor || DEFAULT_HOME_COLOUR
    },
    away: {
      name: prefill?.awayName || '',
      short: prefill?.awayShort || '',
      color: prefill?.awayColor || DEFAULT_AWAY_COLOUR
    }
  }))
  const [bestOf, setBestOf] = useState(prefill?.bestOf === 3 ? 3 : 5)
  const [picking, setPicking] = useState(null) // 'home' | 'away' | null
  const [tried, setTried] = useState(false)

  const set = (team, field, value) => setTeams(prev => ({ ...prev, [team]: { ...prev[team], [field]: value } }))
  const shortOf = (team) => (teams[team].short || defaultShortName(teams[team].name)).trim()
  const missing = (team) => !teams[team].name.trim()

  const start = () => {
    setTried(true)
    if (missing('home') || missing('away') || busy) return
    onStart({
      homeName: teams.home.name.trim(),
      awayName: teams.away.name.trim(),
      homeShort: shortOf('home'),
      awayShort: shortOf('away'),
      homeColor: teams.home.color,
      awayColor: teams.away.color,
      bestOf,
      league: prefill?.league || '',
      gameNumber: prefill?.gameNumber || '',
      hall: prefill?.hall || ''
    })
  }

  const teamBlock = (team) => {
    const label = team === 'home' ? t('easyMatch.home', 'Home team') : t('easyMatch.away', 'Away team')
    return (
      <fieldset className="min-w-0 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</legend>
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => setPicking(team)}
            aria-label={t('easyMatch.chooseColour', { team: label, defaultValue: 'Shirt colour of {{team}}' })}
            className={cn('mt-6 shrink-0 rounded-lg p-1 hover:bg-stone-100', FOCUS_RING)}
          >
            <TeamShirt color={teams[team].color} className="h-11 w-11" />
          </button>
          <div className="grid min-w-0 flex-1 grid-cols-[1fr_5.5rem] gap-2">
            <Field
              label={t('easyMatch.teamName', 'Name')}
              error={tried && missing(team) ? t('easyMatch.nameRequired', 'Required') : undefined}
            >
              <Input
                id={`easy-${team}-name`}
                value={teams[team].name}
                onChange={e => set(team, 'name', e.target.value.slice(0, 60))}
                autoComplete="off"
                invalid={tried && missing(team)}
              />
            </Field>
            <Field label={t('easyMatch.shortName', 'Short')}>
              <Input
                id={`easy-${team}-short`}
                value={teams[team].short}
                placeholder={defaultShortName(teams[team].name)}
                onChange={e => set(team, 'short', e.target.value.toUpperCase().slice(0, 8))}
                autoComplete="off"
              />
            </Field>
          </div>
        </div>
      </fieldset>
    )
  }

  return (
    <Modal title={t('easyMatch.title', 'Easy match')} open={open} onClose={onCancel} width={480}>
      <div className="ov-kit space-y-3 p-1 sm:p-2">
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('easyMatch.intro')}
        </p>
        {teamBlock('home')}
        {teamBlock('away')}
        <div role="radiogroup" aria-label={t('easyMatch.format', 'Format')} className="grid grid-cols-2 gap-2">
          {[5, 3].map(n => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={bestOf === n}
              onClick={() => setBestOf(n)}
              className={cn(
                'min-h-11 rounded-lg border px-3 text-sm font-semibold transition-colors',
                bestOf === n ? 'border-red-500 bg-red-50 text-red-800' : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50',
                FOCUS_RING
              )}
            >
              {t('easyMatch.bestOf', { count: n, defaultValue: 'Best of {{count}}' })}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="xl" onClick={onCancel} className="rounded-lg font-medium">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" size="xl" onClick={start} disabled={busy} aria-busy={busy || undefined} className="rounded-lg">
            {t('easyMatch.start', 'Coin toss')}
          </Button>
        </div>
      </div>

      {picking && (
        <>
          <div className="fixed inset-0 z-[1999] bg-stone-900/50" {...backdropDismiss(() => setPicking(null))} />
          <div
            role="dialog"
            aria-label={t('easyMatch.chooseColour', { team: picking === 'home' ? t('easyMatch.home', 'Home team') : t('easyMatch.away', 'Away team'), defaultValue: 'Shirt colour of {{team}}' })}
            className="fixed left-1/2 top-1/2 z-[2000] min-w-[280px] max-w-[95vw] rounded-2xl border border-stone-200/70 bg-white p-4 shadow-2xl"
            style={{ transform: 'translate(-50%, -50%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <TeamColourPicker
              value={teams[picking].color}
              otherColour={teams[picking === 'home' ? 'away' : 'home'].color}
              onPick={(color) => {
                set(picking, 'color', color)
                setPicking(null)
              }}
            />
          </div>
        </>
      )}
    </Modal>
  )
}
