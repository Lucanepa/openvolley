import { useTranslation } from 'react-i18next'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'

/**
 * What an improper request was for (FIVB 15.11.1), in the Improper request
 * dialog: during the rally or after the whistle, by the wrong person (15.3.1:
 * only the coach, else the assistant coach or the game captain), a second
 * substitution request, time-outs or substitutions used up, or other. Kept
 * on the sanction (payload.reason) and shown in the corrections list.
 *
 * Optional: "Other" is chosen when the dialog opens, so Yes is still one tap.
 * A VIEW only.
 *
 * @param {object} props
 * @param {string[]} props.reasons domain/interruptionRequests IMPROPER_REQUEST_REASONS
 * @param {string} props.value the chosen one
 * @param {(reason:string) => void} props.onChange
 */
export default function ImproperReasonPicker({ reasons, value, onChange }) {
  const { t } = useTranslation()
  return (
    <div className="ov-kit" style={{ textAlign: 'left', marginBottom: '16px' }}>
      <p id="improper-reason-label" className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
        {t('scoreboard.improperReason.title')}
      </p>
      <div role="radiogroup" aria-labelledby="improper-reason-label" data-testid="improper-reason" className="flex flex-col gap-1.5">
        {reasons.map(reason => {
          const selected = reason === value
          return (
            <button
              key={reason}
              type="button"
              role="radio"
              aria-checked={selected}
              data-reason={reason}
              onClick={() => onChange(reason)}
              className={cn(
                'box-border flex w-full min-h-10 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors cursor-pointer',
                selected ? 'border-stone-900 bg-stone-900 font-semibold text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50',
                FOCUS_RING
              )}
            >
              <span aria-hidden="true" className={cn('inline-block size-3.5 shrink-0 rounded-full border-2', selected ? 'border-white bg-white' : 'border-stone-400')} />
              <span className="min-w-0 flex-1">{t(`scoreboard.improperReason.${reason}`)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
