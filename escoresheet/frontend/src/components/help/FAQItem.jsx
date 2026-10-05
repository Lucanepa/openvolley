import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Lightbulb } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'

// One question in the help sheet: a flat row (no card), the question in
// stone-800, the answer in stone-600 under it, and "Show me" as a kit ghost
// button. Rendered inside the panel's `.ov-kit` box.
export default function FAQItem({ questionKey, answerKey, helpId, tooltipKey, onShowMe }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className={cn('flex min-h-12 w-full items-start gap-2 rounded-lg px-2 py-3 text-left text-sm font-medium text-stone-800 transition-colors hover:bg-stone-50', FOCUS_RING)}
      >
        <span className="shrink-0 font-semibold text-stone-400">Q:</span>
        <span className="flex-1">{t(questionKey)}</span>
        <ChevronDown size={14} aria-hidden="true" className={cn('mt-0.5 shrink-0 text-stone-400 transition-transform', isOpen && 'rotate-180')} />
      </button>
      {isOpen && (
        <div className="px-2 pb-3 pl-8 text-sm leading-relaxed text-stone-600">
          <span className="font-semibold text-emerald-700">A: </span>
          {t(answerKey)}

          {helpId && onShowMe && (
            <div className="mt-2.5">
              <Button
                variant="ghost"
                size="sm"
                icon={Lightbulb}
                onClick={(e) => {
                  e.stopPropagation()
                  onShowMe(helpId, tooltipKey)
                }}
              >
                {t('contextHelp.showMe', 'Show me')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
