import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import KitModal from './manage/KitModal'
import { Button, Banner, Mark, MarkRow, EmptyInset } from '../ui'
import { cn } from '../ui/cn.js'
import { preselectedKeys, selectionIssues } from '../domain/playerPool'

/**
 * "Choose the players": every player MatchSetup knows for a team
 * (domain/playerPool: the roster now, an Einsatzliste, the saved team, earlier
 * matches on this device), ticked from a sensible default; "Use N players"
 * hands the ticked ones back. Warnings only (more than 14, two liberos above
 * 12, a third libero, fewer than 6): the setup's own checks decide at the
 * coin toss. One scroller (the list), the footer stays.
 *
 * onApply(selectedEntries) gets the pool entries; MatchSetup turns them into
 * the roster (poolToRoster).
 */
export default function PlayerPoolModal({ open, onClose, onApply, pool, teamLabel }) {
  if (!open) return null
  return <PoolBody {...{ onClose, onApply, pool: Array.isArray(pool) ? pool : [], teamLabel }} />
}

const SOURCE_KEY = { current: 'playerPool.sourceCurrent', imported: 'playerPool.sourceImported', saved: 'playerPool.sourceSaved', earlier: 'playerPool.sourceEarlier' }

function PoolBody({ onClose, onApply, pool, teamLabel }) {
  const { t } = useTranslation()
  const [ticked, setTicked] = useState(() => preselectedKeys(pool))
  const selected = useMemo(() => pool.filter(e => ticked.has(e.key)), [pool, ticked])
  const issues = selectionIssues(selected)

  const toggle = (key) => setTicked(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <KitModal
      open
      onClose={onClose}
      decision
      dismissible={false}
      layout="sections"
      size="md"
      title={t('playerPool.title', { team: teamLabel || '' })}
      description={t('playerPool.description', { count: pool.length })}
      icon={ListChecks}
      closeLabel={t('common.close', 'Close')}
      bodyClassName="space-y-3"
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          variant="positive"
          size="lg"
          disabled={selected.length === 0}
          onClick={() => onApply?.(selected)}
          data-testid="player-pool-apply"
        >
          {t('playerPool.apply', { count: selected.length })}
        </Button>
      </>}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-stone-700" data-testid="player-pool-count">
          {t('playerPool.ticked', { count: selected.length, total: pool.length })}
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" onClick={() => setTicked(new Set(pool.map(e => e.key)))} data-testid="player-pool-all">
            {t('playerPool.selectAll')}
          </Button>
          <Button variant="secondary" size="md" onClick={() => setTicked(new Set())} data-testid="player-pool-none">
            {t('playerPool.selectNone')}
          </Button>
        </div>
      </div>
      {issues.length > 0 && (
        <Banner tone="warning" data-testid="player-pool-warnings">
          {issues.map(i => <span key={i.key} className="block">{t(i.key, i.params)}</span>)}
        </Banner>
      )}
      {pool.length === 0 ? (
        <EmptyInset>{t('playerPool.empty')}</EmptyInset>
      ) : (
        <ul className="-mx-1 divide-y divide-stone-100 border-y border-stone-200" data-testid="player-pool-list">
          {pool.map(e => {
            const on = ticked.has(e.key)
            const name = [e.lastName.toUpperCase(), e.firstName].filter(Boolean).join(' ')
            return (
              <li key={e.key}>
                <label className={cn('flex min-h-11 cursor-pointer items-center gap-3 px-1 py-1.5', on ? 'text-stone-900' : 'text-stone-500')}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(e.key)}
                    className="h-5 w-5 shrink-0 accent-red-600"
                    data-testid="player-pool-row"
                    aria-label={`${e.number ?? ''} ${name}`.trim()}
                  />
                  <span className="w-7 shrink-0 text-right text-base font-bold tabular-nums">{e.number ?? '–'}</span>
                  <span className="min-w-0 flex-1">
                    {/* two lines, not one cut short: at large text on a phone
                        the first name that tells namesakes apart was hidden */}
                    <span className="line-clamp-2 text-sm font-semibold [overflow-wrap:anywhere]" title={name || undefined} data-testid="player-pool-name">{name || '–'}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-stone-400">
                      {e.dob && <span className="tabular-nums">{e.dob}</span>}
                      <span>{(e.lastMatch ? [...e.sources.filter(s => s !== 'earlier'), 'last'] : e.sources)
                        .map(s => (s === 'last' ? t('playerPool.sourceLastMatch') : t(SOURCE_KEY[s]))).join(' · ')}</span>
                    </span>
                  </span>
                  <MarkRow>
                    {e.isLibero && <Mark tone="stone" title={t('matchSetup.libero', 'Libero')}>L</Mark>}
                    {e.isCaptain && <Mark tone="amber" title={t('matchSetup.captain', 'Captain')}>C</Mark>}
                  </MarkRow>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </KitModal>
  )
}
