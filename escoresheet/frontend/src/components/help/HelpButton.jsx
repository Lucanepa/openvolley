import { useTranslation } from 'react-i18next'
import { CircleHelp } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { IconButton } from '../../ui/IconButton.jsx'
import { HEADER_BTN, HEADER_BTN_ON, KIT_SCOPE } from '../chromeClasses'
import { openHelp } from './helpEvents'

/**
 * The "?" of a header bar, the face MainHeader's has (the referee, bench and
 * livescore headers: DashboardHeader, SimpleHeader).
 */
export function HeaderHelpButton({ onClick, pressed = false }) {
  const { t } = useTranslation()
  const label = t('contextHelp.helpButton', 'Help')
  return (
    <span className={KIT_SCOPE}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        className={cn(HEADER_BTN, 'w-9 px-0 text-sm font-bold', pressed && HEADER_BTN_ON)}
      >
        ?
      </button>
    </span>
  )
}

/**
 * The help button in a dialog's title row, beside its close button: opens
 * the help panel on the dialog's screen (helpSections.js HELP_SCREENS).
 */
export function DialogHelpButton({ screen, className }) {
  const { t } = useTranslation()
  return (
    <span className={cn('ov-kit shrink-0', className)}>
      <IconButton
        variant="close"
        icon={CircleHelp}
        label={t('contextHelp.helpButton', 'Help')}
        onClick={() => openHelp(screen)}
        data-testid="dialog-help"
      />
    </span>
  )
}
