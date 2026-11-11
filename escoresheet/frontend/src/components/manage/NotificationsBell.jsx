import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'
import { cn, consoleHeaderBtn, FOCUS_RING, PickerPopover } from '../../ui'
import { notificationsApi } from '../../lib/accountApi'
import { useOnline } from './common'

// How often the bell asks for new notices while the manager is open
export const NOTIFICATIONS_POLL_MS = 60 * 1000

/**
 * The console header's bell (db/027, backend lib/signupNotices.js): the
 * account's own notices in this manager ("Nora Neu signed up"), newest
 * first, with the unread count on the button. A notice opens its page
 * (`onOpen(target)`: the account, My club or My teams) and is marked read;
 * "Mark all read" clears the count. Read every minute and when the window
 * comes back; nothing while offline. Nothing at all on a server without
 * db/027 (the list answers 404 there: no button).
 */
export default function NotificationsBell({ app, onOpen }) {
  const { t, i18n } = useTranslation()
  const online = useOnline()
  const [state, setState] = useState({ list: [], unread: 0, known: false, missing: false })
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)

  const load = useCallback(async () => {
    const res = await notificationsApi.list(app)
    if (res?.status === 404) { setState((s) => ({ ...s, missing: true })); return }
    if (res?.error || !res?.data) return
    setState({ list: res.data.notifications || [], unread: res.data.unread || 0, known: true, missing: false })
  }, [app])

  useEffect(() => {
    if (!online) return undefined
    load()
    const timer = setInterval(load, NOTIFICATIONS_POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [online, load])

  const markRead = async (body) => {
    const res = await notificationsApi.markRead(app, body)
    if (!res?.error && res?.data) setState((s) => ({ ...s, unread: res.data.unread ?? s.unread }))
  }
  const choose = (n) => {
    setOpen(false)
    if (!n.read) {
      setState((s) => ({ ...s, list: s.list.map((x) => (x.id === n.id ? { ...x, read: true } : x)), unread: Math.max(0, s.unread - 1) }))
      markRead({ ids: [n.id] })
    }
    onOpen?.(n.target)
  }
  const markAll = () => {
    setState((s) => ({ ...s, list: s.list.map((x) => ({ ...x, read: true })), unread: 0 }))
    markRead({ all: true })
  }

  if (state.missing) return null
  const { list, unread } = state
  const when = (iso) => {
    try {
      return new Date(iso).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })
    } catch {
      return ''
    }
  }
  const partText = (p) => {
    const kind = t(`access.requests.kinds.${p.kind}`)
    const where = p.kind === 'team_manager' ? (p.team || p.club) : p.club
    return where ? `${kind} · ${where}` : kind
  }
  const label = unread ? t('manage.notifications.buttonUnread', { count: unread }) : t('manage.notifications.title')

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(consoleHeaderBtn, 'relative shrink-0 px-2')}
        onClick={() => { setOpen((v) => !v); if (!open) load() }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="notifications-bell"
      >
        <Bell size={14} aria-hidden />
        {unread > 0 && (
          <span data-testid="notifications-unread" className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-[18px] text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <PickerPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={t('manage.notifications.title')} className="w-[min(22rem,calc(100vw-16px))] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2">
          <h2 className="text-sm font-semibold text-stone-900">{t('manage.notifications.title')}</h2>
          {unread > 0 && (
            <button type="button" onClick={markAll} className={cn('rounded px-1.5 py-1 text-xs font-medium text-stone-600 hover:text-stone-900', FOCUS_RING)}>
              {t('manage.notifications.markAllRead')}
            </button>
          )}
        </div>
        {list.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-stone-500">
            {state.known ? t('manage.notifications.empty') : t('manage.notifications.loading')}
          </p>
        ) : (
          <ul className="max-h-[min(24rem,70vh)] divide-y divide-stone-100 overflow-y-auto" data-testid="notifications-list">
            {list.map((n) => {
              const who = n.user?.name || n.user?.email || t('manage.notifications.deletedAccount')
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => choose(n)}
                    className={cn('flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-stone-50', FOCUS_RING, !n.read && 'bg-red-50/40')}
                  >
                    <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-red-600')} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm', n.read ? 'text-stone-700' : 'font-semibold text-stone-900')}>
                        {t('manage.notifications.signupTitle', { name: who })}
                      </span>
                      {n.user?.name && n.user?.email && <span className="block truncate text-xs text-stone-500">{n.user.email}</span>}
                      <span className="mt-0.5 block text-xs text-stone-600">
                        {n.parts?.length ? n.parts.map(partText).join(', ') : t('manage.notifications.noRole')}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-stone-400">
                        <span>{when(n.created_at)}</span>
                        {n.parts?.length > 0 && (
                          <span className={n.open ? 'font-medium text-amber-700' : 'text-stone-400'}>
                            {n.open ? t('manage.notifications.stillOpen') : t('manage.notifications.decided')}
                          </span>
                        )}
                      </span>
                      {!n.read && <span className="sr-only">{t('manage.notifications.unread')}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PickerPopover>
    </>
  )
}
