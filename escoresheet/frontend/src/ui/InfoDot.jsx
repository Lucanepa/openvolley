// The (i) beside an option's name, with its explanation in a small panel on a
// tap (Options, the scoring screen's options, LookOptions, ThemeOption,
// RallyModeOption through their `kit`). Was a copy in each options dialog,
// its panel centred on the (i) with nothing keeping it on the screen: on a
// phone the Device check's ran off the left edge (owner 28.11.2026). The
// panel and when it closes: ui/infoPopover (the same as ui/InfoHint's).
//
//   <InfoDot title={t('options.look.checkInfo')} />
//
// `title`: the explanation (text or nodes); `label`: the (i)'s name for
// screen readers (default "More information" in the app's language).
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { cn } from './cn.js'
import { useInfoPopover } from './infoPopover.js'

export const INFO_DOT_MAX_WIDTH = 260

export function InfoDot({ title, label, className }) {
  const { t } = useTranslation()
  const { open, wrapRef, triggerProps, panelProps } = useInfoPopover({ maxWidth: INFO_DOT_MAX_WIDTH })
  const name = label || t('common.moreInfo', 'More information')
  return (
    <span ref={wrapRef} data-info-dot="" className={cn('relative inline-flex print:hidden', className)}>
      <button
        {...triggerProps}
        aria-label={name}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500/50',
          open ? 'bg-sky-50 text-sky-700' : 'text-stone-400 hover:bg-sky-50 hover:text-sky-700'
        )}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {/* right after the (i) in the page: a screen reader's next item, the next Tab stop's neighbour */}
      {open && (
        <span
          {...panelProps}
          className="z-[1100] block w-max whitespace-normal rounded-lg border border-stone-300 bg-white px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-stone-700 shadow-xl"
        >
          {title}
        </span>
      )}
    </span>
  )
}

export default InfoDot
