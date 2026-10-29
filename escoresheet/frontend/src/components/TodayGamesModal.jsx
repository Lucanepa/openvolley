import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'
import Modal from './Modal'
import { fetchTodayGames } from '../lib/accountApi'
import { mapSupabaseToMatchFormat, matchDataFromSchedule } from './LoadOfficialMatchModal'
import { Button, Chip, cn, FOCUS_RING, IconButton, Notice } from '../ui'
import { timeLabel } from '../ui/format'

// The last list of the day, per account: a venue whose network drops still
// shows the games (owner plan 2026-10-29, step 3)
const CACHE_KEY = 'ov:todayGames'
export function readCachedTodayGames(userId, day) {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    return v && v.userId === userId && v.day === day ? v.data : null
  } catch {
    return null
  }
}
function cacheTodayGames(userId, data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, day: data.day, data })) } catch { /* the list still shows */ }
}
const zurichToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * Official game, signed in: today's HOME games of the account's clubs
 * (GET /api/games/today). Picking one hands its match data (the schedule
 * picker's, matchDataFromSchedule) to onPick; "Not in the list?" to onManual
 * (a blank match setup: schedule search, typing, Einsatzliste). Offline or on
 * a failed request the day's last list is shown, else only the manual way.
 */
export default function TodayGamesModal({ open, userId, onPick, onManual, onClose }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ loading: true, data: null, failed: false, cached: false })

  useEffect(() => {
    if (!open) return
    let gone = false
    const cached = readCachedTodayGames(userId, zurichToday())
    setState({ loading: true, data: cached, failed: false, cached: !!cached })
    fetchTodayGames({ timeoutMs: 6000 }).then((res) => {
      if (gone) return
      if (res?.error || !res?.data) {
        setState({ loading: false, data: cached, failed: !cached, cached: !!cached })
        return
      }
      cacheTodayGames(userId, res.data)
      setState({ loading: false, data: res.data, failed: false, cached: false })
    }, () => {
      if (!gone) setState({ loading: false, data: cached, failed: !cached, cached: !!cached })
    })
    return () => { gone = true }
  }, [open, userId])

  const games = state.data?.games || []
  const clubs = state.data?.clubs || []
  const pick = (row) => onPick(matchDataFromSchedule(mapSupabaseToMatchFormat(row)))

  return (
    <Modal title="" open={open} onClose={onClose} width={520} hideCloseButton>
      <div className="ov-kit text-stone-800" data-testid="today-games">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-stone-200/70 py-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-stone-900">{t('home.todayGames.title')}</h2>
            {clubs.length > 0 && <p className="truncate text-xs text-stone-500">{clubs.join(' · ')}</p>}
          </div>
          <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} />
        </div>

        {state.cached && <Notice className="mb-3">{t('home.todayGames.offline')}</Notice>}
        {state.loading && !state.data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
            <Loader2 size={16} className="animate-spin text-stone-400" aria-hidden="true" />
            {t('home.todayGames.loading')}
          </div>
        ) : state.failed ? (
          <p className="py-4 text-sm text-stone-600">{t('home.todayGames.failed')}</p>
        ) : clubs.length === 0 ? (
          <p className="py-4 text-sm text-stone-600">{t('home.todayGames.noClub')}</p>
        ) : games.length === 0 ? (
          <p className="py-4 text-sm text-stone-600">{t('home.todayGames.none')}</p>
        ) : (
          <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
            {games.map((g) => (
              <li key={g.game_number}>
                <button
                  type="button"
                  onClick={() => pick(g)}
                  data-testid="today-game"
                  className={cn('flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-stone-50', FOCUS_RING)}
                >
                  <span className="w-12 shrink-0 pt-0.5 text-base font-bold tabular-nums text-stone-900">{g.datetime ? timeLabel(g.datetime) : '–'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold leading-snug text-stone-900">{g.team_home} – {g.team_away}</span>
                    <span className="mt-0.5 block text-xs text-stone-500">
                      {[g.league, g.hall, `#${g.game_number}`].filter(Boolean).join(' · ')}
                    </span>
                    {g.claim && (
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        <Chip tone={g.claim.closed ? 'stone' : g.claim.mine ? 'indigo' : 'amber'}>
                          {g.claim.closed ? t('home.todayGames.closed') : g.claim.mine ? t('home.todayGames.mine') : t('home.todayGames.taken')}
                        </Chip>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-col gap-2 border-t border-stone-200/70 pt-3">
          <p className="text-xs text-stone-500">{t('home.todayGames.notListed')}</p>
          <Button variant="secondary" size="xl" block onClick={onManual} data-testid="today-games-manual">
            {t('home.todayGames.manual')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
