import { useTranslation } from 'react-i18next'
import { ListChecks, X } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'

/**
 * What the self-check on open did or found (utils/deviceSelfCheck), on the
 * home screen in the style of the cloud-block notice: a copy the server has
 * closed (Show: the closed-copy dialog), a second copy of a match removed,
 * or two copies that each hold something (Remove: the delete dialog of the
 * one less far on). Nothing when nothing was found; Dismiss hides it until a
 * check finds something again.
 * @param {{ report: { closed: object[], flagged: object[], removed: object[] }|null,
 *   onShow: (id: number) => void, onRemove: (id: number) => void, onDismiss: () => void }} props
 */
export default function SelfCheckNotice({ report, onShow, onRemove, onDismiss, className = '' }) {
  const { t } = useTranslation()
  const game = (item) => item.gameN ?? '–'
  const lines = [
    ...(report?.closed || []).map(c => ({ key: `closed-${c.id}`, text: t('home.selfCheck.closedCopy', { game: game(c) }), action: t('home.selfCheck.show'), onAction: () => onShow(c.id) })),
    ...(report?.flagged || []).map(c => ({ key: `flagged-${c.id}`, text: t('home.selfCheck.duplicateCopy', { game: game(c) }), action: t('home.selfCheck.remove'), onAction: () => onRemove(c.id) })),
    ...(report?.removed || []).map(c => ({ key: `removed-${c.id}`, text: t('home.selfCheck.removedCopy', { game: game(c) }) }))
  ]
  if (!lines.length) return null
  return (
    <div className={cn('ov-kit', className)}>
      <div role="status" data-testid="self-check-notice" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        <ListChecks size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <ul className="m-0 min-w-0 flex-1 list-none space-y-1.5 p-0">
          {lines.map(l => (
            // Wraps: on a phone the button goes under its text
            <li key={l.key} className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <span className="min-w-0 flex-[1_1_14rem]">{l.text}</span>
              {l.action && (
                <button
                  type="button"
                  onClick={l.onAction}
                  className={cn('ml-auto shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100', FOCUS_RING)}
                >
                  {l.action}
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('home.selfCheck.dismiss')}
          title={t('home.selfCheck.dismiss')}
          className={cn('-mr-1 shrink-0 rounded p-0.5 text-amber-700 hover:bg-amber-100', FOCUS_RING)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
