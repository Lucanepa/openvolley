import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import Modal from '../Modal'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { cn } from '../../ui/cn.js'
import { TEAM_COLOUR_MARK, teamBoxStyle } from '../../utils/teamColours'
import SubstitutionList from './SubstitutionList.jsx'
import { SUB_DIALOG_COURT, subDialogModel } from './subDialogModel.js'

// The scoreboard's bench chip arrows (Scoreboard.jsx, the ↑ ↓ box beside a
// substituted starter): green in, red out
const ARROW_IN = '#047857'
const ARROW_OUT = '#b91c1c'

const str = (v) => (v === undefined || v === null ? '' : String(v))

/**
 * The ↑ ↓ box of a substituted starter with his substitute's number, as the
 * bench chip on the scoreboard draws it.
 */
function PairBox({ number, label }) {
  return (
    <span aria-label={label} title={label} className="inline-flex items-center gap-0.5 rounded-md border border-stone-200 bg-white px-1.5 text-[13px] leading-tight text-stone-900">
      <span aria-hidden="true" style={{ color: ARROW_IN, fontWeight: 900 }}>↑</span>
      <span aria-hidden="true" style={{ color: ARROW_OUT, fontWeight: 900 }}>↓</span>
      <span aria-hidden="true" className="ml-[3px] text-[15px] font-semibold tabular-nums">{number}</span>
    </span>
  )
}

/**
 * A player: his number (circled for the captain), under it the court
 * position or a substituted starter's ↑ ↓ box. 66 px high: a scoring-screen
 * target.
 */
function PlayerTile({ number, sub = null, captain = false, liberoPaint = null, pressed, disabled = false, onClick, label, testId }) {
  const painted = !!liberoPaint && !pressed
  // A painted tile that cannot be tapped (the libero) keeps its shirt but
  // reads no louder than the greyed tiles round it: a 1px edge in the ring
  // colour, faded (the hairline without a ring), instead of the scoreboard's
  // 2px ring, and fainter (a white shirt with its ring stood out as the
  // active tile)
  const quietPaint = painted && disabled
  const paintStyle = painted
    ? {
        background: liberoPaint.bg,
        color: liberoPaint.text,
        ...(quietPaint
          ? { border: `1px solid ${liberoPaint.ring ? `color-mix(in srgb, ${liberoPaint.ring} 40%, transparent)` : 'var(--ov-hairline)'}` }
          : (liberoPaint.border ? { border: liberoPaint.border } : {})),
        ...TEAM_COLOUR_MARK
      }
    : undefined
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-[66px] min-w-[76px] flex-col items-center justify-center gap-1 rounded-xl border p-1.5 transition-colors',
        FOCUS_RING,
        pressed ? 'border-2 border-yellow-500 bg-yellow-100 text-stone-900' : painted ? 'border-transparent' : 'border-stone-200 bg-stone-50 text-stone-900',
        disabled ? cn('cursor-default', quietPaint ? 'opacity-40' : 'opacity-50') : (!pressed && !painted && 'hover:bg-stone-100')
      )}
      style={paintStyle}
    >
      <span className={cn(
        'font-bold tabular-nums leading-none',
        captain ? 'flex h-[34px] min-w-[34px] items-center justify-center rounded-full border-2 border-current px-1 text-[18px]' : 'text-[22px]'
      )}>{number}</span>
      {sub !== null && (
        <span className={cn('text-[11px] leading-none', painted ? 'opacity-80' : 'text-stone-500')}>{sub}</span>
      )}
    </button>
  )
}

// A court place left empty (a player the chosen one may not replace, the
// libero): the court keeps its shape
function EmptyPlace({ position }) {
  return (
    <div aria-hidden="true" className="flex min-h-[66px] items-center justify-center rounded-xl border border-dashed border-stone-200 text-[11px] text-stone-400">
      {position}
    </div>
  )
}

const Hint = ({ children, testId, className = 'self-center' }) => (
  <span data-testid={testId} className={cn('text-sm text-stone-500', className)}>{children}</span>
)

/**
 * The SUB box's substitution: tap who comes in (bench), then who goes out
 * (court); the pair goes to the list and the dialog is back at "who comes
 * in" for another; Confirm records them all, Cancel nothing (owner
 * 23.11.2026, mockup v9). Only legal players are shown: a bench player
 * nobody may be replaced by is not listed, and once one is chosen only the
 * court players he may replace stay (the others and the libero leave an
 * empty place). Never past the 6 with the pairs waiting.
 *
 * A VIEW: the rules come in `legalIns` (the Scoreboard's
 * getAvailableSubstitutes per court player) and the Scoreboard records the
 * pairs (onConfirm), each through its substitution confirm path. The props
 * come from the Scoreboard's subPickerFor: the tablet shows it in its dialog
 * (SubstitutionDialog below), the phone in its SUB sheet (PhoneScoreboard);
 * on a narrow screen the bench stacks above the court.
 *
 * @param {object} props
 * @param {'left'|'right'} props.side the team's side on the scoring screen (the court's layout)
 * @param {Array<{position:string, number:any, isLibero?:boolean, isCaptain?:boolean}>} props.court
 * @param {Array<{number:any, isCaptain?:boolean, cameOutFor?:any}>} props.bench
 *   cameOutFor: a substituted starter's substitute (the ↑ ↓ box)
 * @param {Record<string, any[]>} props.legalIns court number -> bench numbers that may come in for him
 * @param {number} props.made regular substitutions recorded in the set
 * @param {number} [props.max]
 * @param {string|null} [props.blockReason] 'replay_pending': no regular substitution now
 * @param {Array} [props.recordedList] the "Recorded" view (Scoreboard getSubstitutionDetails)
 * @param {Array<any>} [props.captainNumbers] who leaving asks for a game captain after Confirm
 * @param {{bg:string, text:string, border?:string}|null} [props.liberoPaint] the libero's shirt on the scoreboard
 * @param {(pairs: Array<{in:string, out:string, position:string}>) => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @param {(player: {position:string, number:string}) => void} props.onInjury the injured player tapped
 */
export function SubstitutionPicker({ side = 'right', court = [], bench = [], legalIns = {}, made = 0, max = 6, blockReason = null, recordedList = [], captainNumbers = [], liberoPaint = null, onConfirm, onCancel, onInjury }) {
  const { t } = useTranslation()
  const [view, setView] = useState('new')
  const [pending, setPending] = useState([])
  const [pick, setPick] = useState(null)
  const [injury, setInjury] = useState(false)

  const blocked = !!blockReason
  const model = subDialogModel({ court, bench, legalIns, made, max, pending: blocked ? [] : pending })
  const canAdd = model.canAdd && !blocked && !injury
  const picked = pick !== null && canAdd && model.outsFor(pick).length > 0 ? str(pick) : null
  const legalOuts = picked ? model.outsFor(picked) : []
  const isCaptain = (n) => captainNumbers.some(c => str(c) === str(n))
  const layout = SUB_DIALOG_COURT[side === 'left' ? 'left' : 'right']

  const addPair = (out) => {
    const at = court.find(c => str(c.number) === str(out))
    if (!picked || !at) return
    setPending(list => [...list, { in: picked, out: str(out), position: at.position }])
    setPick(null)
  }
  const removePair = (i) => {
    setPending(list => list.filter((_, k) => k !== i))
    setPick(null)
  }

  // ---- In · bench ----
  let benchBody
  if (injury) {
    benchBody = null
  } else if (blocked) {
    benchBody = null
  } else if (!model.canAdd) {
    benchBody = (
      <Hint testId="sub-dialog-in-full">
        {model.full
          ? t('scoreboard.subDialog.noneLeft', 'No regular substitution left.')
          : pending.length > 1
            ? t('scoreboard.subDialog.fullWithMore', { max, defaultValue: '{{max}} of {{max}} with the ones below.' })
            : t('scoreboard.subDialog.fullWithOne', { max, defaultValue: '{{max}} of {{max}} with the one below.' })}
      </Hint>
    )
  } else if (model.ins.length === 0) {
    benchBody = <Hint testId="sub-dialog-in-none">{t('scoreboard.subDialog.nobody', 'Nobody on the bench may come in.')}</Hint>
  } else {
    benchBody = model.ins.map(b => {
      const n = str(b.number)
      const backFor = b.cameOutFor !== undefined && b.cameOutFor !== null && b.cameOutFor !== '' ? str(b.cameOutFor) : null
      return (
        <PlayerTile
          key={n}
          testId={`sub-dialog-in-${n}`}
          number={n}
          captain={!!b.isCaptain}
          sub={backFor ? <PairBox number={backFor} label={t('scoreboard.subDialog.backFor', { number: backFor, defaultValue: 'Comes back for #{{number}}' })} /> : null}
          pressed={picked === n}
          label={t('scoreboard.subDialog.comesIn', { number: n, defaultValue: 'Comes in: #{{number}}' })}
          onClick={() => setPick(p => (str(p) === n ? null : n))}
        />
      )
    })
  }

  // ---- Out · on court ----
  const courtTiles = layout.map(position => {
    const c = model.courtNow.find(p => p.position === position)
    const n = str(c?.number)
    if (!c || n === '') return <EmptyPlace key={position} position={position} />
    if (c.isLibero) {
      // never substituted (libero replacements keep their own flow)
      if (picked || injury) return <EmptyPlace key={position} position={position} />
      return <PlayerTile key={position} testId={`sub-dialog-court-${n}`} number={n} sub={position} liberoPaint={liberoPaint || { bg: '#dbeafe', text: '#1e3a8a', ring: '#93c5fd', border: '1px solid #93c5fd' }} disabled label={t('scoreboard.subDialog.libero', { number: n, defaultValue: 'Libero #{{number}}' })} />
    }
    if (injury) {
      // the injured player: the injury / exceptional substitution, as a tap on him
      if (c.incoming) return <EmptyPlace key={position} position={position} />
      return (
        <PlayerTile
          key={position}
          testId={`sub-dialog-injury-${n}`}
          number={n}
          sub={position}
          captain={!!c.isCaptain}
          label={t('scoreboard.subDialog.injuredPlayer', { number: n, defaultValue: 'Injured: #{{number}}' })}
          onClick={() => onInjury?.({ position, number: n })}
        />
      )
    }
    if (!picked) {
      return <PlayerTile key={position} testId={`sub-dialog-court-${n}`} number={n} sub={position} captain={!!c.isCaptain} disabled label={t('scoreboard.subDialog.goesOut', { number: n, defaultValue: 'Goes out: #{{number}}' })} />
    }
    if (!legalOuts.includes(n)) return <EmptyPlace key={position} position={position} />
    return (
      <PlayerTile
        key={position}
        testId={`sub-dialog-out-${n}`}
        number={n}
        sub={position}
        captain={!!c.isCaptain}
        label={t('scoreboard.subDialog.goesOut', { number: n, defaultValue: 'Goes out: #{{number}}' })}
        onClick={() => addPair(n)}
      />
    )
  })

  const step = injury
    ? t('scoreboard.subDialog.stepInjury', 'Tap the injured player')
    : !canAdd
      ? ''
      : picked
        ? t('scoreboard.subDialog.stepOut', { number: picked, defaultValue: 'Tap who goes out for #{{number}}' })
        : t('scoreboard.subDialog.stepIn', 'Tap who comes in')
  const stepNumber = injury ? null : picked ? 2 : 1
  const activeColumn = injury ? 'out' : !canAdd ? null : picked ? 'out' : 'in'
  const column = (which) => cn('min-w-0 rounded-xl border-2 p-2.5', activeColumn === which ? 'border-yellow-500' : 'border-transparent')
  const countFull = model.total >= max

  return (
    <div className="ov-kit flex flex-col gap-3.5" data-testid="sub-dialog" data-side={side}>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <SegmentedControl
          variant="joined"
          ariaLabel={t('scoreboard.subDialog.view', 'View')}
          value={view}
          onChange={setView}
          className="[&>button]:h-10 [&>button]:text-sm"
          options={[
            { value: 'new', label: t('scoreboard.subDialog.tabNew', 'New') },
            { value: 'recorded', label: t('scoreboard.subDialog.tabRecorded', { n: recordedList.length, defaultValue: 'Recorded ({{n}})' }) }
          ]}
        />
        <span
          data-testid="sub-dialog-count"
          className={cn('rounded-full border px-2.5 py-1 text-sm font-semibold tabular-nums', countFull ? 'border-red-300 bg-red-100 text-red-700' : 'border-stone-200 text-stone-800')}
        >
          {t('scoreboard.subDialog.count', { made, max, defaultValue: '{{made}} of {{max}}' })}
          {pending.length > 0 && !blocked ? ` · ${t('scoreboard.subDialog.toConfirm', { n: pending.length, defaultValue: '{{n}} to confirm' })}` : ''}
        </span>
      </div>

      {view === 'recorded' ? (
        <div data-testid="sub-dialog-recorded"><SubstitutionList details={recordedList} /></div>
      ) : (
        <div className="flex flex-col gap-3">
          {model.full && !blocked && (
            <div data-testid="sub-dialog-full-note" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 text-sm text-red-800">
              {t('scoreboard.subDialog.fullNote', { max, defaultValue: '{{max}} of {{max}}: no regular substitution left this set. For an injured or expelled/disqualified player use “Injury / exceptional”.' })}
            </div>
          )}
          {blocked && (
            <div data-testid="sub-dialog-block-note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              {t(`scoreboard.requestBlock.${blockReason}_short`, { defaultValue: t(`scoreboard.requestBlock.${blockReason}`) })}
            </div>
          )}
          {step && (
            <div data-testid="sub-dialog-step" className="flex min-h-[22px] items-center text-[15px] font-semibold text-stone-900">
              {stepNumber && (
                <span aria-hidden="true" className="mr-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-stone-900 text-xs text-white">{stepNumber}</span>
              )}
              {step}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <section className={column('in')} aria-label={t('scoreboard.subDialog.colIn', 'In · bench')}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-500">{t('scoreboard.subDialog.colIn', 'In · bench')}</h4>
              <div className="flex min-h-[66px] flex-wrap content-start gap-2">{benchBody}</div>
            </section>
            <section className={column('out')} aria-label={t('scoreboard.subDialog.colOut', 'Out · on court')}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-500">{t('scoreboard.subDialog.colOut', 'Out · on court')}</h4>
              {/* the net: the thick line on the front-row side */}
              <div
                data-testid="sub-dialog-court"
                className={cn('grid grid-cols-2 gap-2', side === 'left' ? 'border-r-4 border-stone-500 pr-3' : 'border-l-4 border-stone-500 pl-3')}
              >
                {courtTiles}
              </div>
            </section>
          </div>
          {pending.length > 0 && !blocked && (
            <div data-testid="sub-dialog-pairs" className="flex flex-col gap-2 border-t border-stone-200 pt-3">
              {pending.map((p, i) => (
                <div key={`${p.in}-${p.out}`} data-testid={`sub-dialog-pair-${p.in}-${p.out}`} className="flex flex-wrap items-center gap-2.5 font-semibold text-stone-900">
                  <span className="tabular-nums">{made + i + 1} ·</span>
                  <span>
                    <Trans
                      i18nKey="scoreboard.subDialog.pair"
                      defaults="<in>#{{in}} in</in> for <out>#{{out}} out</out>"
                      values={{ in: p.in, out: p.out }}
                      components={{ in: <span style={{ color: ARROW_IN }} />, out: <span style={{ color: ARROW_OUT }} /> }}
                    />
                  </span>
                  {isCaptain(p.out) && (
                    <small data-testid="sub-dialog-captain-note" className="text-sm font-normal text-stone-500">
                      {t('scoreboard.subDialog.captainAfter', 'after “Confirm”: pick the game captain')}
                    </small>
                  )}
                  <Button variant="ghost" size="md" className="h-10 px-3 text-sm" onClick={() => removePair(i)} data-testid={`sub-dialog-remove-${p.in}-${p.out}`}>
                    {t('scoreboard.subDialog.remove', 'Remove')}
                  </Button>
                </div>
              ))}
              {model.canAdd && (
                <Hint className="self-start">{t('scoreboard.subDialog.another', 'For another substitution: tap the next player coming in.')}</Hint>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Button
          variant={model.full || blocked ? 'danger-outline' : 'secondary'}
          size="xl"
          aria-pressed={injury}
          disabled={pending.length > 0 && !blocked}
          data-testid="sub-dialog-injury"
          className={cn('min-w-[88px]', injury && 'border-2 border-yellow-500 bg-yellow-100 text-stone-900 hover:bg-yellow-100')}
          onClick={() => { setView('new'); setPick(null); setInjury(v => !v) }}
        >
          {t('scoreboard.subDialog.injury', 'Injury / exceptional')}
        </Button>
        <div className="flex gap-2.5">
          {/* data-modal-close: Android's Back is Cancel (appLifecycle.js) */}
          <Button variant="secondary" size="xl" className="min-w-[88px]" onClick={onCancel} data-modal-close="" data-testid="sub-dialog-cancel">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="positive"
            size="xl"
            className="min-w-[88px]"
            disabled={pending.length === 0 || blocked}
            onClick={() => onConfirm?.(pending.map(p => ({ ...p })))}
            data-testid="sub-dialog-confirm"
          >
            {t('common.confirm', 'Confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The tablet's dialog: the picker in the app's modal, titled with the team
 * (its A/B in the team colour) as the substitution confirmation is.
 * @param {object} props SubstitutionPicker's, and
 * @param {string} props.teamLabel 'A' | 'B'
 * @param {string} props.teamName
 * @param {string|null} props.teamColor
 */
export default function SubstitutionDialog({ teamLabel, teamName, teamColor, ...picker }) {
  const { t } = useTranslation()
  return (
    <Modal
      open={true}
      onClose={picker.onCancel}
      width={920}
      hideCloseButton={true}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span style={{ ...teamBoxStyle(teamColor) }} className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 text-[13px] font-bold">{teamLabel}</span>
          <span className="min-w-0 truncate">{t('scoreboard.labels.substitutionFull', 'Substitution')}{teamName ? ` · ${teamName}` : ''}</span>
        </span>
      }
    >
      <SubstitutionPicker {...picker} />
    </Modal>
  )
}
