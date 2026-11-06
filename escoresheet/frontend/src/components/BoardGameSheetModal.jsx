import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { Button } from '../ui'
import { boardGameSheet, boardGames } from '../utils/pointHubBoard'

/**
 * "Load from Wiedisync" on a Point Hub board's own screen: today's home games
 * as the board has them, then that game's match info and home roster.
 * @param {{ open: boolean, onClose: () => void, onLoad: (sheet: object) => void }} props
 */
export default function BoardGameSheetModal({ open, onClose, onLoad }) {
  const { t } = useTranslation()
  const [games, setGames] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const [partial, setPartial] = useState(null)

  useEffect(() => {
    if (!open) return undefined
    let gone = false
    setGames(null); setError(''); setBusy(null); setPartial(null)
    boardGames()
      .then((r) => {
        if (gone) return
        if (r.ok) setGames(r.games)
        else { setGames([]); setError(r.error || t('boardSheet.noBoard')) }
      })
      .catch(() => { if (!gone) { setGames([]); setError(t('boardSheet.noBoard')) } })
    return () => { gone = true }
  }, [open, t])

  const pick = async (game) => {
    setBusy(game.id); setError('')
    try {
      const r = await boardGameSheet(game.id)
      if (!r.ok) setError(r.error || t('boardSheet.noBoard'))
      else if (r.roster?.ok) onLoad(r)
      else setPartial(r)
    } catch {
      setError(t('boardSheet.noBoard'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title={t('boardSheet.title')} open={open} onClose={onClose} width={620}>
      <div className="ov-kit space-y-3 p-1 sm:p-2">
        {partial ? (
          <>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {t('boardSheet.noRoster')} {partial.roster?.error}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="xl" onClick={() => setPartial(null)}>{t('common.back', 'Back')}</Button>
              <Button variant="primary" size="xl" onClick={() => onLoad(partial)}>{t('boardSheet.infoOnly')}</Button>
            </div>
          </>
        ) : (
          <>
            {games === null && <p className="py-6 text-center text-sm text-stone-500">{t('boardSheet.loading')}</p>}
            {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            {games?.length === 0 && !error && <p className="py-6 text-center text-sm text-stone-500">{t('boardSheet.noGames')}</p>}
            <div className="divide-y divide-stone-100">
              {games?.map((g) => (
                <div key={g.id} className="flex items-center gap-3 py-2" data-testid="board-game-row">
                  <span className="w-14 shrink-0 text-base font-bold tabular-nums text-stone-900">{String(g.time || '').slice(0, 5)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-stone-900">{g.home} – {g.away}</span>
                    <span className="block truncate text-xs text-stone-500">{[g.hall, g.league].filter(Boolean).join(' · ')}</span>
                  </span>
                  <Button variant="primary" size="xl" disabled={busy != null} onClick={() => pick(g)}>
                    {busy === g.id ? t('boardSheet.loading') : t('boardSheet.load')}
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex justify-end"><Button variant="secondary" size="xl" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button></div>
          </>
        )}
      </div>
    </Modal>
  )
}
