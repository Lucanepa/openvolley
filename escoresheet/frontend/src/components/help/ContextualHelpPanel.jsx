import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleHelp, X } from 'lucide-react'
import FAQItem from './FAQItem'
import { helpContent } from './helpContent'
import { IconButton } from '../../ui/IconButton.jsx'
import { backdropDismiss } from '../../ui/backdropDismiss.js'

const pageNames = {
  home: 'contextHelp.pageNames.home',
  matchSetup: 'contextHelp.pageNames.matchSetup',
  coinToss: 'contextHelp.pageNames.coinToss',
  scoreboard: 'contextHelp.pageNames.scoreboard',
  matchEnd: 'contextHelp.pageNames.matchEnd',
  manualAdjustments: 'contextHelp.pageNames.manualAdjustments'
}

// volleyui side sheet: white panel with a stone hairline and shadow-xl,
// eyebrow page name under a text-base title, the round × close, and the
// questions as flat rows with stone-100 dividers. Behaviour unchanged (slides
// in from the right; Escape and the phone backdrop close it).
export default function ContextualHelpPanel({ open, onClose, currentPage, onShowMe }) {
  const { t } = useTranslation()

  const items = helpContent[currentPage] || []
  const pageName = pageNames[currentPage] ? t(pageNames[currentPage]) : currentPage

  // ESC to close
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  return (
    <>
      {/* Backdrop - only on narrow screens to dismiss */}
      {open && (
        <div
          {...backdropDismiss(onClose)}
          className="no-print fixed inset-0 bg-slate-900/40"
          style={{
            zIndex: 1000,
            display: window.innerWidth < 500 ? 'block' : 'none'
          }}
        />
      )}

      {/* Panel */}
      <div
        role="complementary"
        aria-label={t('contextHelp.helpButton', 'Help')}
        className="ov-kit no-print fixed bottom-0 right-0 top-0 flex flex-col border-l border-stone-200 bg-white text-stone-800"
        style={{
          width: window.innerWidth < 500 ? '100%' : 340,
          zIndex: 1001,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          // visibility follows the slide, so the closed panel's rows leave the tab order
          transition: 'transform 0.3s ease-out, visibility 0.3s',
          visibility: open ? 'visible' : 'hidden',
          boxShadow: open ? '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)' : 'none'
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-bold text-stone-900">
              <CircleHelp size={18} className="shrink-0 text-stone-400" aria-hidden="true" />
              {t('contextHelp.helpButton', 'Help')}
            </div>
            <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              {pageName}
            </div>
          </div>
          <IconButton variant="close" label={t('modal.close', 'Close')} icon={X} onClick={onClose} className="-mr-2" />
        </div>

        {/* FAQ List */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {items.length > 0 ? (
            <div className="divide-y divide-stone-100">
              {items.map((item, i) => (
                <FAQItem
                  key={i}
                  questionKey={item.questionKey}
                  answerKey={item.answerKey}
                  helpId={item.helpId}
                  tooltipKey={item.tooltipKey}
                  onShowMe={onShowMe}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 py-14 text-center text-sm font-medium text-stone-500">
              {t('contextHelp.noHelp', 'No help available for this page.')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-stone-100 px-4 py-3 text-center text-[11px] text-stone-400">
          OpenVolley eScoresheet
        </div>
      </div>
    </>
  )
}
