import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../Modal'
import { Button } from '../../ui/Button.jsx'
import { cn } from '../../ui/cn.js'

// The badge in front of an entry: T for a time-out, S for a substitution
// (amber for an exceptional one), and the card itself for a sanction.
function NoticeBadge({ tone }) {
  const box = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold'
  if (tone === 'timeout') return <span aria-hidden="true" className={cn(box, 'bg-sky-100 text-sky-800')}>T</span>
  if (tone === 'substitution') return <span aria-hidden="true" className={cn(box, 'bg-stone-100 text-stone-800')}>S</span>
  if (tone === 'exceptional') return <span aria-hidden="true" className={cn(box, 'bg-amber-100 text-amber-900')}>S</span>
  const card = 'inline-block h-7 w-5 rounded-[3px] shadow-sm ring-1 ring-black/10'
  if (tone === 'yellow') return <span aria-hidden="true" className={box}><span className={cn(card, 'bg-yellow-300')} /></span>
  if (tone === 'red') return <span aria-hidden="true" className={box}><span className={cn(card, 'bg-red-600')} /></span>
  if (tone === 'redYellow') {
    return <span aria-hidden="true" className={box}><span className={cn(card, 'bg-[linear-gradient(90deg,#e2001a_50%,#fde047_50%)]')} /></span>
  }
  if (tone === 'redYellowApart') {
    return (
      <span aria-hidden="true" className={cn(box, 'gap-0.5')}>
        <span className={cn(card, 'w-4 bg-red-600')} />
        <span className={cn(card, 'w-4 bg-yellow-300')} />
      </span>
    )
  }
  return <span aria-hidden="true" className={cn(box, 'bg-stone-100 text-stone-700')}>!</span>
}

/**
 * The referee tablets' summary of what the scorer just recorded: time-outs,
 * substitutions and sanctions, oldest first. OK closes it; it closes by
 * itself at `deadline` (10 s after its last entry came in).
 */
export default function RecordedNoticePopup({ notices, deadline, onClose }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!deadline) return undefined
    const left = deadline - Date.now()
    if (left <= 0) { onClose(); return undefined }
    // the clock as the popup opens (or gets an entry), not when it last ticked
    setNow(Date.now())
    const close = setTimeout(onClose, left)
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => { clearTimeout(close); clearInterval(tick) }
  }, [deadline, onClose])

  if (!notices?.length) return null
  const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0

  return (
    <Modal open={true} onClose={onClose} width={480} hideCloseButton={true}>
      <div className="ov-kit" data-testid="referee-recorded-popup">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="m-0 text-lg font-bold text-stone-900">
            {t('refereeDashboard.recorded.title', 'Recorded by the scorer')}
          </h3>
          {notices.length > 1 && (
            <span className="rounded-full bg-stone-900 px-2.5 py-0.5 text-sm font-semibold text-white">{notices.length}</span>
          )}
        </div>
        <ul role="list" aria-live="polite" className="m-0 mb-4 flex list-none flex-col gap-2 p-0">
          {notices.map(n => (
            <li key={n.key} className="flex items-center gap-3 rounded-xl border border-stone-200/70 bg-stone-50 px-3 py-2.5">
              <NoticeBadge tone={n.tone} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold leading-snug text-stone-900">
                  <span>{n.title}</span>
                  {n.detail && <span className="font-medium text-stone-700">{n.detail}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-stone-600">
                  {n.team && (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: n.team.color }} />
                      <span className="truncate font-medium text-stone-800">{n.team.name}{n.team.letter ? ` (${n.team.letter})` : ''}</span>
                    </span>
                  )}
                  <span>{n.setLabel}</span>
                  {n.score && <span className="tabular-nums">{n.score}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="dark" size="xl" block className="h-14 text-base" onClick={onClose}>
          {t('common.ok', 'OK')}
        </Button>
        <p className="mb-0 mt-2 text-center text-sm text-stone-500">
          {t('refereeDashboard.recorded.closesIn', 'Closes in {{s}} s', { s: seconds })}
        </p>
      </div>
    </Modal>
  )
}
