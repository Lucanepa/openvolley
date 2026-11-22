import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../Modal'
import { Button } from '../../ui/Button.jsx'
import { Switch } from '../../ui/Switch.jsx'

// Court position order of the six: IV III II (front row), V VI I (back row)
const POSITION_ORDER = ['IV', 'III', 'II', 'V', 'VI', 'I']

/**
 * The scorer's "Game captain" dialog (FIVB 5.1.2), on the tablet and the
 * phone layout alike. A VIEW only: the Scoreboard records (onSelect,
 * onKeepChange).
 *
 * - 'choose': a game captain is needed (the team captain is off court and no
 *   acting game captain is among the six). The six on court, the last game
 *   captain proposed when on court (one tap), and the "Keep as game captain"
 *   switch: the tap designates the player with the switch as it is then
 *   (onSelect(number, keep)); Cancel changes nothing.
 * - 'settings': opened from the Game captain button while the switch is on
 *   and nobody is to be chosen (the role is fixed once acting, FIVB 5.1.2):
 *   who leads the team now and the switch, which applies at once
 *   (onKeepChange); the scorer turns it off here.
 *
 * @param {object} props
 * @param {'choose'|'settings'} props.mode
 * @param {Record<string, string|number>} props.lineup the six by position (I..VI)
 * @param {string|number|null} props.remembered the last game captain
 * @param {boolean} props.keep the switch as stored
 * @param {string|number|null} [props.acting] settings: the acting game captain
 * @param {string|number|null} [props.captainOnCourt] settings: the team captain, when he is on court
 * @param {(number: string|number, keep: boolean) => void} props.onSelect
 * @param {(keep: boolean) => void} props.onKeepChange
 * @param {() => void} props.onClose
 */
export default function GameCaptainDialog({ mode = 'choose', lineup = {}, remembered = null, keep = false, acting = null, captainOnCourt = null, onSelect, onKeepChange, onClose }) {
  const { t } = useTranslation()
  const labelId = useId()
  const hintId = useId()
  // choose: the switch is part of the tap (Cancel leaves it as stored)
  const [keepDraft, setKeepDraft] = useState(keep === true)
  useEffect(() => { setKeepDraft(keep === true) }, [keep])

  const onCourt = (n) => n != null && n !== '' && Object.values(lineup || {}).some(x => String(x) === String(n))
  const proposed = remembered != null && remembered !== '' && onCourt(remembered) ? String(remembered) : null

  const keepRow = (
    <div className="ov-kit" data-testid="game-captain-keep">
      <div className="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5">
        <div className="min-w-0">
          <div id={labelId} className="text-sm font-semibold text-stone-800">
            {t('scoreboard.captainOnCourt.keep', 'Keep as game captain')}
          </div>
          <div id={hintId} className="mt-0.5 text-xs leading-snug text-stone-500">
            {t('scoreboard.captainOnCourt.keepHint', 'Not asked again while this player is on court')}
          </div>
        </div>
        <Switch
          checked={mode === 'choose' ? keepDraft : keep === true}
          onCheckedChange={(next) => (mode === 'choose' ? setKeepDraft(next === true) : onKeepChange?.(next === true))}
          tone="amber"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          data-testid="game-captain-keep-switch"
          // p-0: the global button padding (styles.css) squeezed the thumb
          className="mt-0.5 shrink-0 p-0"
        />
      </div>
    </div>
  )

  const closeButton = (label) => (
    <span className="ov-kit contents">
      <Button variant="secondary" size="lg" className="h-11 min-w-[88px] w-full" onClick={onClose}>{label}</Button>
    </span>
  )

  if (mode === 'settings') {
    const status = acting != null && acting !== ''
      ? t('scoreboard.captainOnCourt.acting', { n: acting, defaultValue: '#{{n}} is game captain' })
      : captainOnCourt != null && captainOnCourt !== ''
        ? t('scoreboard.captainOnCourt.captainOnCourt', { n: captainOnCourt, defaultValue: 'Captain #{{n}} is on court' })
        : null
    return (
      <Modal title={t('scoreboard.captainOnCourt.selectTitle', 'Game captain')} open={true} onClose={onClose} width={360}>
        <div className="flex flex-col gap-3">
          {status && <p className="m-0 text-sm text-stone-700" data-testid="game-captain-status">{status}</p>}
          {keep === true && remembered != null && remembered !== '' && String(remembered) !== String(acting ?? '') && (
            <p className="m-0 text-sm text-stone-700" data-testid="game-captain-kept">
              {t('scoreboard.captainOnCourt.kept', { n: remembered, defaultValue: 'Kept: #{{n}}' })}
            </p>
          )}
          {keepRow}
          {closeButton(t('common.close', 'Close'))}
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={t('scoreboard.captainOnCourt.selectTitle', 'Game captain')} open={true} onClose={onClose} width={360}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px' }}>
          {POSITION_ORDER.map((pos) => {
            const playerNumber = lineup?.[pos]
            if (!playerNumber) return <div key={pos} />
            const isProposed = proposed != null && String(playerNumber) === proposed
            return (
              <button
                key={pos}
                type="button"
                onClick={() => onSelect?.(playerNumber, keepDraft)}
                aria-label={isProposed ? `${playerNumber} (${t('scoreboard.captainOnCourt.last', 'Last game captain')})` : undefined}
                style={{
                  padding: '12px 8px',
                  background: isProposed ? '#eab308' : 'rgba(234, 179, 8, 0.15)',
                  border: `2px solid ${isProposed ? '#ca8a04' : 'rgba(234, 179, 8, 0.5)'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '24px',
                  fontWeight: 700,
                  color: isProposed ? '#1c1917' : '#eab308',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  lineHeight: 1.1
                }}
              >
                {playerNumber}
                {isProposed && (
                  <span style={{ fontSize: '11px', fontWeight: 600, marginTop: '2px' }}>
                    {t('scoreboard.captainOnCourt.lastShort', 'Last')}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div style={{ marginBottom: '12px' }}>{keepRow}</div>
        {closeButton(t('common.cancel', 'Cancel'))}
      </div>
    </Modal>
  )
}
