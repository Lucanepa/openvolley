import { useTranslation } from 'react-i18next'
import Modal from '../Modal'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING, Button } from '../../ui/Button.jsx'

/**
 * The warning before a time-out or substitution request that the rules do
 * not allow as it stands (domain/interruptionRequests.js): a second
 * substitution request in the same interruption, the player who just came
 * in going out again, the 7th substitution, the 3rd time-out, a request
 * after a delay warning, an illegal substitution.
 *
 * Every option says what it records, taken from the sanction ladder when the
 * dialog opened (`consequences`), so the scorer sees it before the tap:
 *  improper        the improper-request ladder (15.11.2 / 15.11.3)
 *  delay           the delay ladder (16.1, 16.2)
 *  timeoutStarted  the delay ladder: the 3rd time-out was already granted (CB 4.29)
 *  illegal         the delay ladder: an illegal substitution requested (16.1.3)
 *  continue        nothing (the referee allowed the request)
 *
 * A VIEW only: the Scoreboard decides and records (onChoose).
 *
 * @param {object} props
 * @param {{reason:string, options:string[], kind:string}} props.issue
 * @param {{ label:string, name:string, paint?:object }} props.team the requesting team
 * @param {{ label:string, name:string }} props.opponent
 * @param {{ improper:'improper_request'|'delay_warning'|'delay_penalty', delay:'delay_warning'|'delay_penalty' }} props.consequences
 * @param {object} [props.details] { number, returning, between } for the texts
 * @param {(option:string) => void} props.onChoose
 */
export default function RequestWarningDialog({ issue, team, opponent, consequences, details = {}, onChoose }) {
  const { t } = useTranslation()
  if (!issue) return null
  const reason = issue.reason
  const teamName = `${team.label} (${team.name})`
  const opponentName = `${opponent.label} (${opponent.name})`
  const vars = { team: teamName, opponent: opponentName, ...details }

  const recorded = (type) => {
    if (type === 'improper_request') return t('scoreboard.requestWarning.records.improper')
    if (type === 'delay_warning') return t('scoreboard.requestWarning.records.delayWarning')
    return t('scoreboard.requestWarning.records.delayPenalty', { opponent: opponentName })
  }
  const optionText = {
    improper: {
      label: t('scoreboard.requestWarning.options.improper'),
      sub: consequences.improper === 'improper_request'
        ? recorded('improper_request')
        : `${recorded(consequences.improper)} ${t('scoreboard.requestWarning.records.repeatedImproper')}`,
      card: consequences.improper === 'improper_request' ? null : consequences.improper
    },
    delay: { label: t('scoreboard.requestWarning.options.delay'), sub: recorded(consequences.delay), card: consequences.delay },
    timeoutStarted: { label: t('scoreboard.requestWarning.options.timeoutStarted'), sub: recorded(consequences.delay), card: consequences.delay },
    illegal: { label: t('scoreboard.requestWarning.options.illegal'), sub: recorded(consequences.delay), card: consequences.delay },
    continue: { label: t('scoreboard.requestWarning.options.continue'), sub: t('scoreboard.requestWarning.records.nothing') }
  }
  const choices = issue.options.filter(o => o !== 'cancel')
  const isNotice = issue.kind === 'notice'

  return (
    <Modal
      title={t(`scoreboard.requestWarning.${reason}.title`, vars)}
      open={true}
      onClose={() => onChoose('cancel')}
      width={460}
      hideCloseButton={true}
      zIndex={1100}
    >
      <div className="ov-kit" data-testid="request-warning" data-reason={reason}>
        <div className="flex items-center gap-2 mb-3">
          <span
            className="inline-flex items-center justify-center rounded px-1.5 text-[11px] font-bold leading-5"
            style={team.paint}
          >
            {team.label}
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-stone-700">{team.name}</span>
        </div>
        <p className="m-0 text-sm leading-relaxed text-stone-800">
          {t(`scoreboard.requestWarning.${reason}.text`, vars)}
        </p>
        {details.between && (
          <p className="mt-1.5 mb-0 text-xs text-stone-500">{t('scoreboard.requestWarning.since', { what: details.between })}</p>
        )}
        <p className="mt-2 mb-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
          {t(`scoreboard.requestWarning.${reason}.rule`)}
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {isNotice && (
            <Button variant="dark" size="xl" block data-option="cancel" onClick={() => onChoose('cancel')}>
              {t('common.cancel')}
            </Button>
          )}
          {choices.map(option => {
            const { label, sub, card } = optionText[option]
            return (
              <RequestOptionRow
                key={option}
                option={option}
                label={label}
                sub={sub}
                card={card}
                quiet={option === 'continue'}
                onClick={() => onChoose(option)}
              />
            )
          })}
          {!isNotice && (
            <Button variant="secondary" size="xl" block data-option="cancel" className="mt-1" onClick={() => onChoose('cancel')}>
              {t('common.cancel')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * One option of a request warning (or of the late-request replay): what it
 * does, what it records, and the card it gives (yellow: delay warning, red:
 * delay penalty). h-12 at least, the whole row is the button.
 * @param {{ option:string, label:string, sub:string, card?:string|null, quiet?:boolean, onClick:() => void, testId?:string }} props
 */
export function RequestOptionRow({ option, label, sub, card = null, quiet = false, onClick, testId }) {
  return (
    <button
      type="button"
      data-option={option}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'box-border flex w-full min-h-12 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors cursor-pointer',
        quiet ? 'border-stone-200 bg-stone-50 hover:bg-stone-100' : 'border-stone-300 bg-white hover:bg-stone-50',
        FOCUS_RING
      )}
    >
      <span aria-hidden="true" className="inline-flex w-4 shrink-0 justify-center">
        {card && <span className={`sanction-card ${card === 'delay_penalty' ? 'red' : 'yellow'}`} style={{ display: 'block', width: 12, height: 16, borderRadius: 2 }} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-sm font-semibold', quiet ? 'text-stone-700' : 'text-stone-900')}>{label}</span>
        <span className="text-xs text-stone-500">{sub}</span>
      </span>
    </button>
  )
}
