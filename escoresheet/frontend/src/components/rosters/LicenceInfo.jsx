import { useTranslation } from 'react-i18next'
import { InfoHint } from '../../ui/InfoHint.jsx'

// The (i) beside "Licence" (owner 2026-11-25, tester: scorers used to dates of
// birth looked for them): what the column holds and why. Match setup's roster
// and bench tables and the roster editor of the scoring screen.
export function LicenceInfo({ className = 'ml-1 normal-case tracking-normal' }) {
  const { t } = useTranslation()
  return (
    <InfoHint
      className={className}
      eyebrow={t('idMode.label.licence', 'Licence')}
      label={t('idMode.info.label', 'What goes in the licence column')}
      closeLabel={t('common.close', 'Close')}
    >
      <span data-testid="licence-info" className="block text-[13px] font-normal leading-snug text-stone-700">
        {t('idMode.info.licence', 'The Swiss Volley licence number identifies the player on the scoresheet. Dates of birth are no longer used (data protection). For someone without a licence, type the date of birth with dots (dd.mm.yyyy).')}
      </span>
    </InfoHint>
  )
}
